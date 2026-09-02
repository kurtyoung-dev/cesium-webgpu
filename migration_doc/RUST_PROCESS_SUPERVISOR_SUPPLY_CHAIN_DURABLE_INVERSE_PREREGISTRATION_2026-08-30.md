# Rust process-supervisor durable supply-chain inverse preregistration

**Status: PREREGISTERED / RECORD ONLY / NO EXECUTION AUTHORITY.** This record replaces only
the non-durable transport shape of the post-lock-refresh inverse run. It does not erase that
run, upgrade its lost evidence, authorize a retry, release Cargo, or certify the Rust process
supervisor. The supply-chain gate remains **NO-GO**.

## 1. Authority, incident, and exact boundary

The prior source-only inverse result was described in
`Tools/process-supervisor/SUPPLY_CHAIN.md`, but its raw outer envelope and exact predicate
streams lived only under the orchestration-session key `rust_supply_inverse_run_v1`. After the
Codex cache reset, a root-session read returned exactly `MISSING`. Denethor's independent
physical review reproduced the live inputs, vendor closure, retained metadata, and both mutant
byte streams, but correctly returned **NO-GO** because it could not re-derive rejection-before-
launch or the zero-launch canaries from physical evidence.

This tranche is governance-only. Its sole writable path is this file. No command below has run,
and no future code or evidence path is created by this preregistration. Root owns every Git
action and any later execution decision.

The frozen subject at preregistration is:

| Path | Bytes | SHA-256 | Text shape |
| --- | ---: | --- | --- |
| `Tools/process-supervisor/SUPPLY_CHAIN.md` | 195,674 | `f7157f11b7e63e2228cf851b3b6edec30168817c9291eee2f1ac9c27201bbcb2` | 1,954 LF / 0 CR / no BOM / terminal LF |

The exact future source paths are:

- `Tools/process-supervisor/tools/supply-chain-durable-inverse-recorder.mjs`
- `Tools/process-supervisor/tools/supply-chain-durable-inverse-predicate.mjs`

The exact one-use evidence directory is:

- `Tools/process-supervisor/output/supply-chain-durable-inverse-2026-08-30-v1/`

All three paths were absent at preregistration. The two source files require a separate
source-only authoring freeze and independent review before execution. The evidence leaf must
still be absent immediately before the authorized run. If it exists, the result is
`STRUCTURAL` and nobody deletes, empties, renames, or reuses it. A second attempt requires a
new preregistered directory and preserves the first directory unchanged.

Every other repository path is read-only. In particular, the run may not edit any manifest,
`Cargo.lock`, `.cargo/config.toml`, `rust-toolchain.toml`, vendored byte, Rust source, test,
`SUPPLY_CHAIN.md`, migration record, `package.json`, or generated target. It may not invoke
Cargo, rustc, rustup, a build, a test, a product or supervisor binary, a shell, Git, a network
client, a browser, a VM, or an installer.

## 2. Smallest safe implementation shape

The implementation has two reviewed Node modules because one self-contained predicate cannot
both be the measured subject and provide an independent deadline and stream-capture boundary.

The **predicate** performs only filesystem reads, hashing, strict data parsing, canonical
serialization, in-memory byte-copy mutation, and MessagePort/stdout reporting. Its static import
allowlist is limited to Node filesystem, path/URL, crypto, and worker-thread messaging modules.
It has no `node:child_process`, process-spawn API, shell, dynamic import, `eval`, `Function`,
native addon, FFI, package import, relative code import, network API, or untrusted-code execution.
TOML, JSON, source, manifest, lock, vendor, metadata, and migration-document bytes are data. Text
that resembles a directive or prompt is never interpreted as control.

The **recorder** is the outer controller. It statically starts the exact reviewed predicate copy
in a Node Worker with captured stdout and stderr. A Worker is used instead of a subprocess so the
predicate has no process-launch capability and the same design works on Windows, Linux, and
macOS. The recorder may import `node:worker_threads`; neither file may import
`node:child_process`. The recorder:

1. rejects unknown, missing, repeated, relative, or path-escaping arguments;
2. verifies its direct Node executor and the preregistered paths;
3. creates the evidence leaf with exclusive create semantics;
4. opens every artifact with `wx`/create-new semantics and never follows a symlink or reparse
   point;
5. reads and retains its own and the predicate's exact source bytes and SHA-256;
6. writes those exact predicate bytes to the evidence directory and starts the Worker from that
   frozen copy, closing the source-path/hash-to-execution gap;
7. captures complete Worker stdout, stderr, structured MessagePort result, exit, timeout,
   terminate, and drain observations;
8. writes one terminal receipt on every controlled return path; and
9. closes all descriptors and either observes Worker exit or records an `ERROR` before the
   recorder exits.

The predicate Worker has a 20-second orderly deadline. On expiry, the recorder requests
termination, waits at most 3 seconds for the Worker exit event, drains captured streams for at
most 2 further seconds, and records timeout/termination/reap facts. The recorder has a separate
30-second terminal-receipt deadline. Root's execution adapter has an outer 45-second hard limit;
if the recorder has not exited, root terminates the exact Node handle and waits it. A missing or
nonterminal receipt after that hard stop is `ERROR`, never PASS, and the one-use directory is
banked as-is. Because the Worker is source-reviewed to have no launch primitive, there is no
descendant process tree to orphan.

The source freeze must retain each code file's bytes, SHA-256, LF/CR/BOM/terminal-LF shape, static
imports, and forbidden-token scan, but the full independent source read is the authority. A token
scan alone cannot approve executable bytes.

## 3. Exact direct executor and command

The only permitted direct executable is the current Node binary, frozen without invoking it:

| Path | Bytes | File/product version | SHA-256 |
| --- | ---: | --- | --- |
| `C:\Program Files\nodejs\node.exe` | 86,997,320 | `22.23.2` | `0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4` |

At execution, the recorder must additionally require `process.execPath` to resolve to that same
physical file, `process.version` to equal `v22.23.2`, `process.platform` to equal `win32`, and
`process.arch` to equal `x64`; it re-reads and hashes the executor bytes as data. Any difference is
`STRUCTURAL` before the predicate Worker starts. This preregisters a Windows-hosted recovery
result only; the predicate design is portable, but this run makes no Linux or macOS claim.

After the preregistration and code tuples receive their required reviews, root may release this
exact single command once:

```powershell
& 'C:\Program Files\nodejs\node.exe' --no-addons --no-warnings 'F:\Dev\GH\cesium-webgpu\Tools\process-supervisor\tools\supply-chain-durable-inverse-recorder.mjs' --repo-root 'F:\Dev\GH\cesium-webgpu' --output-dir 'F:\Dev\GH\cesium-webgpu\Tools\process-supervisor\output\supply-chain-durable-inverse-2026-08-30-v1'
```

The working directory is exactly `F:\Dev\GH\cesium-webgpu`. No environment variable supplies an
executable, repository, predicate, metadata, or output path. The recorder rejects any additional
argument. The command does not imply authority to run it.

## 4. Frozen live inputs and current canonical tuple

The predicate reads the following thirteen physical files before any mutation and again after all
controls. Each canonical record is
`<forward-slash logical path><TAB><decimal bytes><TAB><lowercase sha256><LF>`. Records are sorted
by the UTF-8 bytes of the logical path, serialized as UTF-8 without BOM, and terminated by exactly
one LF. The current serialization is 1,312 bytes / SHA-256
`a3ab97284316b0c09edc271ae440dc92db0f7956e7d44e4a22ebcae1d8c762a6`.

| Logical path relative to `Tools/process-supervisor` | Bytes | SHA-256 |
| --- | ---: | --- |
| `Cargo.toml` | 992 | `179c592964901b2abcbd432f904f92f546e16d14b8fd335fb4b9d51048f26e2d` |
| `Cargo.lock` | 6,609 | `681d72ab1726a739f5e9240ab1a9eca9a91e4bcfcab5456464cec8f5889a4a83` |
| `rust-toolchain.toml` | 87 | `6152f0907eaac1d9806d46246c4c9715bfdb7eaa400323a34b9f493ff0e6f946` |
| `.cargo/config.toml` | 123 | `992df442f8e3a3e2188c6088a75abaf7a6311926e02e1392d4090b1a5b27fd62` |
| `crates/proc-supervisor-cli/Cargo.toml` | 470 | `68c7c8a92251be922230ce67d339ce76affb7f3f2237dbbb3961604d905ccd03` |
| `crates/q152-process-runner/Cargo.toml` | 454 | `3b15ee3ad1fbad1711f7c549f76b05ca470b0f627c18d9c12f652d7adb1da1f0` |
| `crates/supervisor-core/Cargo.toml` | 235 | `f967857f7d167d59668ed53e8321c953be0a25f99aed0651ad8e6c5ce268f09c` |
| `crates/supervisor-native/Cargo.toml` | 406 | `b286343a1f489c3110feb86847f9595c9ddeeec5937293a5851dc9dc9e924c73` |
| `crates/supervisor-protocol/Cargo.toml` | 362 | `63ca376b15e0183fc0e56a50938ae95f097aaea6fdc57af7af086b1066769c5f` |
| `crates/supervisor-test-child/Cargo.toml` | 259 | `25b42df907e3a4a331e2fd2d7dfef520c74e103493646a7bb2a97940d4f7ff86` |
| `tests/Cargo.toml` | 488 | `0aee198b9a84f4ccb75227bb9bbf87d520d7caf8f092a36a454dae6f97a67b82` |
| `SUPPLY_CHAIN.md` | 195,674 | `f7157f11b7e63e2228cf851b3b6edec30168817c9291eee2f1ac9c27201bbcb2` |
| `../../migration_doc/RUST_PROCESS_SUPERVISOR_CARGO_LOCK_REFRESH_PREREGISTRATION_2026-08-30.md` | 9,547 | `8bf0681b1373f9f5f3d06654ecff88bcdfa0abbe1e1cae0131f9da73dd056f24` |

The earlier predicate-time tuple used the 184,665-byte prefix of `SUPPLY_CHAIN.md` and therefore
had SHA-256 `c1abf90fc4f3eaea63c4fb3e3be8d219bd1028cc1e09f319bc7173061c81ca6f`.
That historical identity is retained for provenance only. The new run must use the complete current
subject and the `a3ab...` tuple above. Both the pre- and post-run physical tuples must match all
thirteen registered identities and each other. The exact 1,312 canonical bytes, not a reconstructed
summary, are retained as artifacts so path-order, separator, encoding, and terminal-LF arithmetic
remain independently auditable.

## 5. Vendor, resolver, metadata, and toolchain provenance

The complete live vendor boundary is preregistered as 1,383 regular files / 30,423,571 bytes /
canonical SHA-256
`ca954a20ea857cc4e43e965d505671d56bcd9184095309311b66482d036f1f05`.
The predicate generates and retains the full before/after 1,383-row manifests; both must match the
embedded complete manifest in `SUPPLY_CHAIN.md`, the registered count/bytes/hash, and one another.
Symlinks, reparse points, nonregular entries, duplicate normalized paths, unreadable files, or an
extra/missing row are `STRUCTURAL`.

The refreshed lock contains 32 package blocks: seven local workspace packages and 25 registry
packages. The 25 registry name/version/checksum records must equal the 25 top-level versioned
vendor directories. The local arrays must still include `sha2` in `proc-supervisor-cli` and
`sha2` plus `windows-sys` in `process-supervisor-tests`.

The retained prior metadata streams are exact physical data inputs:

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `C:\Users\Kurt\AppData\Local\Temp\codex-rust-metadata-b16fd8a449b842639ea69b33c329c01d\metadata.stdout.json` | 123,501 | `693093b689490c802805ccf2a8cbc36684a24afa53faa4a6204707d348ccfb4c` |
| `C:\Users\Kurt\AppData\Local\Temp\codex-rust-metadata-b16fd8a449b842639ea69b33c329c01d\metadata.stderr.bin` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The recorder copies both streams byte-for-byte into create-new artifacts before the Worker starts.
Strict data-only JSON parsing must yield 32 packages, 25 registry packages, seven workspace
members, and the same registry name/version set as the lock and vendor tree. Missing or changed
metadata is `STRUCTURAL`; the run does not recreate it or invoke Cargo.

The metadata was produced by the previously retained toolchain tuple:

| Executable | Bytes | SHA-256 | Recorded version |
| --- | ---: | --- | --- |
| `C:\Users\Kurt\.rustup\toolchains\1.94.0-x86_64-pc-windows-msvc\bin\cargo.exe` | 30,754,304 | `cbfdfc04b61ba49d184c6d3996502a00391d570cb5cb71a00faeb8c0ce12a4c9` | `cargo 1.94.0 (85eff7c80 2026-01-15)` |
| `C:\Users\Kurt\.rustup\toolchains\1.94.0-x86_64-pc-windows-msvc\bin\rustc.exe` | 111,104 | `6a0699e427ee9c1492ef1c9ea967d035dc4660e92c7fe32f2c6a1038116700e5` | `rustc 1.94.0 (4a4ef493e 2026-03-02)` |

The predicate may hash those executable files as inert bytes but may not invoke them. Matching
bytes bind the prior metadata's recorded provenance; they do not create a fresh resolver,
compiler, or environment observation.

## 6. Complete no-mutation censuses

Before starting the Worker, and again after it exits, the recorder/predicate retain three
canonical censuses:

1. the exact thirteen-input tuple in section 4;
2. the complete vendor manifest in section 5; and
3. every regular first-party file under `Tools/process-supervisor/**`, recursively, excluding
   only `vendor/**`, generated `target/**`, and evidence `output/**`, plus this preregistration
   file as an explicit external governance row.

The first-party census includes both future tool source files, every Rust source and test,
workspace/member manifest, lock, Cargo configuration, design/test/security/supply-chain document,
fixture, and other non-generated file in the process-supervisor tree. Paths are normalized and
serialized by the same canonical record rule as section 4. A symlink/reparse point, nonregular
entry, normalized-path collision, read error, added/deleted file, byte/hash change, or first-party
pre/post manifest difference is `STRUCTURAL`. The output directory is excluded only because it is
the append-only evidence sink; `target/**` is explicitly outside the source claim and must not be
used as evidence. Root freezes other Rust lanes during the short run so a concurrent legitimate
edit cannot contaminate the census.

The predicate never writes a live source path. Mutation uses independent Buffer copies. The
recorder is the sole writer and may write only create-new files inside the exact evidence leaf.

## 7. Registered predicate and negative controls

The identity gate receives a thirteen-record tuple and a test-owned `onLaunchPermitted` callback.
The callback only increments an in-memory counter and records a nonce; it has no process or file
side effect. The unchanged live tuple is a positive wiring control: it must be accepted and invoke
the callback exactly once. Each inverse gets a fresh counter initialized to zero and must be
rejected before the callback, leaving `0 -> 0`.

### 7.1 Config byte-flip inverse

Copy the live 123 config bytes and XOR byte offset 0 with `0x01`, changing `0x5b` to `0x5a`.
Require exactly one changed byte, unchanged length, mutant SHA-256
`3d00279785e55a40d6e5f702d91810965b00a438bafc265fa3333d7f0a36d782`,
and current-complete mutant tuple SHA-256
`c456f53797584d1c97f82876579e2af828e731802b968c33874655a39663fcbd`.
The historical-prefix mutant tuple remains
`31e296d0c3faa19094199aae094a038189ac43ba96d8e2749988500cb6008d42`;
it is provenance, not the new acceptance value. The gate must report `accepted=false`,
`launch_permitted=false`, exactly one mismatch naming `.cargo/config.toml`, and callback count
`0 -> 0`.

### 7.2 Exact stale-lock inverse

Strictly decode the 6,609 live lock bytes as LF-only UTF-8. On a copy, verify and remove the three
exact literals in descending offset order:

| Offset | Bytes | UTF-8 hex | Base64 |
| ---: | ---: | --- | --- |
| 2,603 | 16 | `202277696e646f77732d737973222c0a` | `ICJ3aW5kb3dzLXN5cyIsCg==` |
| 2,528 | 9 | `202273686132222c0a` | `ICJzaGEyIiwK` |
| 2,369 | 9 | `202273686132222c0a` | `ICJzaGEyIiwK` |

Require exactly 34 removed bytes, reconstructed length 6,575, stale-lock SHA-256
`f786d3ec5ae18179b94b2710d9a565c33843e9db4546a65e28488c3f50822023`,
and current-complete mutant tuple SHA-256
`1d2d869032320fb50ac7f23b2fbaba480820e8f3aebf7b344952d25de20cfb58`.
The historical-prefix mutant tuple remains
`0dc0af2a59ef246d207881d7bfa3beeca6abe7dcf9ba76d37e8cc24eca1c30ae`;
it is provenance, not the new acceptance value. The gate must report `accepted=false`,
`launch_permitted=false`, exactly one mismatch naming `Cargo.lock`, and callback count `0 -> 0`.

### 7.3 In-memory instrument controls

These controls operate on copies or synthetic result records and never edit or execute repository
bytes:

- **Inert/no-op mutant:** pass unchanged config bytes to the mutant-nonvacuity checker. It must
  reject the control because changed-byte count is zero and mutant hash/tuple equal the live
  values. If it does not, the real inverse result is unscorable (`STRUCTURAL`).
- **Live-file mutation detector:** change one hash only in an in-memory clone of the post-run
  first-party census. The census comparator must name exactly that row and reject equality. A
  comparator that accepts it makes the run `STRUCTURAL`.
- **Launch-callback bypass:** pass a synthetic otherwise-accepted authorization record with
  `launch_permitted=true` but callback count `0 -> 0` to the canary invariant. It must report
  `launch_callback_bypass`. A checker that accepts the record makes the run `STRUCTURAL`.
- **Callback overfire:** the unchanged live-tuple positive control must reject counts other than
  exactly `0 -> 1`. This distinguishes an armed canary from an always-zero or multiply-called
  counter.
- **Tuple substitution:** a mutant must not be evaluated against the historical 184,665-byte
  subject prefix. Substituting the old `c1ab...` tuple must be detected as current-input drift and
  remain pre-callback.
- **Canonical-order mutant:** swap only the first two records of the correctly sorted stream,
  leaving every row byte unchanged. Require 1,312 bytes / SHA-256
  `f69dbb979a02e48c4ae32b889a9d286ebd344678d5863136f10e408245805aca`,
  and require the canonical-byte validator to reject it. This control prevents a temporary sorted
  view from being checked while an unsorted original collection is hashed.
- **Separator mutant:** replace only the first TAB separator with one ASCII space while leaving
  every row value unchanged. Require 1,312 bytes / SHA-256
  `b34460cce801853530142c41dd54b21657f20ec950f7b65aeaf9db117eb6327f`
  and rejection by the raw canonical-byte validator.
- **Terminal-LF mutant:** remove only the final LF from the otherwise exact stream. Require 1,311
  bytes / SHA-256
  `1e091b3b84c79225a0dc8388ca3aed3088782411529c641fea96713e38e46d90`
  and rejection by the raw canonical-byte validator.

The two real inverses are valid complete measurements. If either real mutant reaches the callback,
is accepted, has a wrong mismatch set, or misses its exact expected mutant identity while all
instrument/provenance prerequisites remain valid, the outcome is `FAIL`, not `ERROR` or
`STRUCTURAL`.

## 8. Exact evidence topology

The recorder creates only the following files inside the one-use evidence directory, each with
exclusive create semantics:

| Artifact | Required content |
| --- | --- |
| `request.json` | exact command arguments, preregistration identity, frozen input/vendor/metadata/executor expectations, deadlines, and expected artifact names |
| `recorder.mjs` | byte-identical copy of the reviewed recorder source |
| `predicate.mjs` | byte-identical copy actually used as the Worker entry |
| `executor.json` | absolute/resolved Node path, bytes, SHA-256, file/product/process versions, platform, arch, PID, start/end monotonic times |
| `metadata.stdout.json` | exact retained 123,501-byte metadata stream |
| `metadata.stderr.bin` | exact retained zero-byte metadata stderr |
| `inputs.before.tsv` / `inputs.after.tsv` | exact raw canonical thirteen-input streams, each 1,312 bytes and independently hashable |
| `vendor.before.tsv` / `vendor.after.tsv` | complete canonical 1,383-row vendor manifests |
| `first-party.before.tsv` / `first-party.after.tsv` | complete canonical first-party manifests |
| `predicate.stdout.bin` / `predicate.stderr.bin` | raw, unmodified Worker fd streams and completeness flags in the receipt |
| `recorder.stdout.bin` / `recorder.stderr.bin` | exact controlled outer streams; stdout is the fixed UTF-8/LF line `{\"receipt\":\"receipt.json\"}` and stderr is empty, independent of receipt contents; the execution adapter must observe identical bytes |
| `result.json` | exact structured Worker result, schema-validated by the recorder |
| `artifact-manifest.tsv` | path, decimal bytes, and lowercase SHA-256 for every earlier artifact; it explicitly excludes itself and the later receipt to avoid a circular hash |
| `receipt.json` | single terminal status fold, exit, reason codes, lifecycle/timeout/reap facts, stream identities, manifest identity, all predicate outcomes, no-mutation results, and claim limits |

An evidence-leaf collision is a preflight refusal and the command is not invoked. After the leaf
is exclusively created, the recorder opens `receipt.json` create-new before any other fallible
run step and holds the descriptor
without publishing partial JSON. On every controlled terminal path it writes exactly one complete
UTF-8/LF JSON value, flushes, closes, and never reopens or replaces it. A zero-length, partial,
duplicate, or absent receipt is `ERROR` and cannot support a claim. Only after the receipt is
closed does the recorder emit the fixed line retained in `recorder.stdout.bin`; deliberate stderr
is empty on every controlled outcome. Stream overflow, truncation, incomplete drain, extra
MessagePort results, trailing
structured bytes, or mismatch between emitted and retained recorder streams is `ERROR`.

`artifact-manifest.tsv` is written only after all primary artifacts except the receipt are closed
and re-read. The receipt records the manifest bytes/SHA and the exact allowed directory-entry set.
A post-run reviewer separately hashes the manifest and receipt and rejects any missing, extra,
changed, nonregular, linked, or open artifact. No in-memory key, chat transcript, command-adapter
chunk, or console summary is an evidence prerequisite.

## 9. Terminal status fold and exit contract

The receipt status and process exit are folded once by maximum severity on the frozen order
`PASS / 0 < FAIL / 1 < ERROR / 2 < STRUCTURAL / 3`:

1. **`STRUCTURAL` / exit 3:** pre-existing evidence leaf; executor/source/preregistration drift;
   missing or malformed registered input, vendor, metadata, resolver, toolchain, census, schema,
   artifact topology, or provenance; a symlink/reparse/nonregular boundary; pre/post live-byte
   drift; or any inertness/detector/canary/canonicalization self-control that fails to discriminate.
2. **`ERROR` / exit 2:** recorder or Worker exception; deadline; failed termination/reap or stream
   drain; output I/O failure after the leaf is created; missing/multiple Worker result; stream
   overflow/truncation; or inability to publish a complete terminal receipt.
3. **`FAIL` / exit 1:** the complete valid gate measurement evaluates both registered real
   inverses, but either is accepted, launch-permitted, reaches the callback, reports the wrong
   mismatch, or misses its registered exact mutation result.
4. **`PASS` / exit 0:** every structural/provenance/lifecycle/artifact predicate is complete; all
   pre/post bytes match; every self-control discriminates; the live tuple calls the test canary
   exactly once; both exact mutants reject with `0 -> 0`; and nothing is unscored.

Higher-precedence states cannot be overwritten by a lower one. A valid measured red remains
`FAIL`. A partial or unevaluable run is never FAIL or PASS. The execution adapter's observed exit
must equal the receipt exit, or the physical review returns NO-GO.

## 10. Cleanup, freeze, and reviews

Cleanup means only closing files, terminating and reaping the Worker when needed, and releasing
handles. The recorder creates no scratch path outside the evidence leaf. It never deletes or
rewrites an artifact, live input, source file, metadata source, vendor byte, target byte, or output
directory. PASS, FAIL, ERROR, STRUCTURAL, timeout, and interrupted directories are all retained.

Release order is strict:

1. Freeze this preregistration and obtain two fresh independent unconditional GOs over its exact
   byte/hash tuple.
2. Separately author only the two named Node files; perform no run. Freeze their exact tuples and
   obtain independent source/security and evidence-lifecycle GOs.
3. Root rehashes this record, the code, all thirteen inputs, metadata, and vendor boundary; freezes
   every Rust lane; confirms the evidence leaf is absent; and releases the exact command once.
4. Freeze the complete physical evidence directory immediately after terminal exit. No author,
   executor, or sibling edits or reruns it.
5. A fresh independent reviewer who was neither author nor executor reads the retained code and
   artifacts, terminally rehashes every path, reconstructs both mutants in memory, independently
   recomputes the status fold, compares raw streams with the result and receipt, rehashes the live
   input/vendor/first-party/metadata boundaries, and returns unconditional GO or NO-GO. The review
   performs no execution or edit.

A conditional GO is NO-GO. Any drift reopens the relevant freeze and requires a new reviewed
tuple. The current reviewers of this preregistration do not review future code or future evidence.

## 11. Claim boundary and continuing hold

A final PASS plus fresh physical-review GO would establish only that, on the exact Windows/Node,
source, vendor, metadata, and record tuple above, the reviewed identity predicate rejected the two
registered in-memory mutants before a test-owned callback and retained durable evidence while the
live boundary stayed byte-identical.

It would not establish a fresh Cargo resolver or compiler run, dependency safety, license
approval, buildability, test success, product behavior, process containment, descendant cleanup,
Q-152 correctness, Linux/macOS support, release readiness, or Rust-tool certification. It cannot
be cited as user-facing platform documentation.

The supply-chain/Cargo gate remains **NO-GO** until this exact preregistration is independently GO,
the two future code files are independently reviewed, root executes the exact command once, the
physical artifacts freeze, and a fresh independent physical review returns unconditional GO.
Only root may then decide whether a separately preregistered Cargo/build/test tranche is released.
This record itself grants no execution or Cargo authority.

## 12. Append-only V2 repair authority and preserved V1 result

Sections 1 through 11 are the immutable V1 incident record. The first 26,451 physical bytes remain
exactly SHA-256 9bba5c319832f75a65cc57770de8d755d35e94462a70f660cb3f80f0008b84fa,
399 LF, zero CR, no UTF-8 BOM, and a terminal LF. V2 does not reinterpret a V1 NO-GO as evidence.
It supersedes V1 only for future source authoring, runner construction, evidence topology, status
folding, and release order.

The two V1 reviews were terminal and drift-free:

| Reviewer | Verdict | Preserved blocker |
| --- | --- | --- |
| Mithrellas, evidence durability | **NO-GO** | No adapter-authored physical artifact independently retained the actually observed recorder exit/stdout/stderr; the path-launched recorder also left root-hash-to-Node-open TOCTOU. |
| Pengolodh, predicate and provenance | **NO-GO** | The same two blockers, plus no recorder-wide closed import/execution boundary and no same-validator positive acceptance control for the exact canonical 1,312-byte stream. |

Both reviews rehashed V1 as 26,451 bytes / the hash above and the subject as 195,674 bytes /
f7157f11b7e63e2228cf851b3b6edec30168817c9291eee2f1ac9c27201bbcb2; neither observed drift.
All four findings are accepted. Nothing in V1 authorizes executing its obsolete path-based command
or creating Tools/process-supervisor/output/supply-chain-durable-inverse-2026-08-30-v1/.

## 13. V2 objects, exact paths, and trust boundary

V2 registers exactly three future reviewed sources:

~~~text
Tools/process-supervisor/tools/supply-chain-durable-inverse-adapter.mjs
Tools/process-supervisor/tools/supply-chain-durable-inverse-recorder.mjs
Tools/process-supervisor/tools/supply-chain-durable-inverse-predicate.mjs
~~~

It registers exactly one future evidence leaf:

~~~text
Tools/process-supervisor/output/supply-chain-durable-inverse-2026-08-30-v2/
~~~

All four paths were absent at the V2 collision check; the obsolete V1 leaf was absent too. Their
absence is not execution evidence and must be checked again immediately before the one allowed
run.

The adapter is the outer evidence controller and the only filesystem writer. The recorder is a
child process observed through the adapter's retained ChildProcess object and pipes. The
predicate is a Worker owned by the recorder. The certifying execution subject is **the recorder
child as actually observed by the reviewed, byte-bound adapter**, not the adapter's own console or
the root tool's transient command result. After a cache reset, the adapter-owned physical envelope
must independently reconstruct the child launch, PID/object-handle binding, raw stdout/stderr,
exit/signal, timestamps, timeout, termination, reap, and drain facts.

Root's later observation of the adapter exit is only a same-run cross-check. Root must refuse to
freeze a run when that observed exit disagrees with receipt.json, but neither the receipt nor a
future physical reviewer may claim to prove the adapter's own outer exit after session output is
lost. The adapter, exact Node executable, Node module loader, filesystem primitives, and
node:child_process observation semantics are an explicit local trusted computing base. V2 claims
no standalone attestation and no OS process-containment fact.

## 14. By-value adapter bootstrap and direct runner

### 14.1 Exact canonical adapter envelope

Root must read the independently reviewed live adapter source exactly once into one byte buffer,
verify that buffer against its later source-freeze byte count and SHA-256, and derive the launch
argument from that same buffer. A changed path before the read fails the registered hash; a change
after the read cannot change the argument. No live adapter pathname is passed to Node.

The single application argument is canonical RFC 4648 base64, with padding, of this byte envelope:

~~~text
ASCII "CESIUM_SUPPLY_INVERSE_ADAPTER_V2\n"
ASCII canonical-decimal adapter-byte-length + LF
ASCII lowercase 64-hex adapter SHA-256 + LF
exact adapter source bytes
~~~

The source must be strict UTF-8, 1 through 18,000 bytes, LF-only, without BOM, and with terminal
LF. The decoded header length and SHA must match the source bytes, and canonical re-encoding must
equal the one argument byte-for-byte. The complete base64 argument may not exceed 24,576 ASCII
characters.

### 14.2 Exact fixed bootstrap B2

B2 is exactly the UTF-8 text inside the next code fence, excluding the fences, joined with LF,
with no CR, no BOM, and no terminal LF:

~~~js
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
const fail = (status, line) => {
  process.stderr.write(line + "\n");
  process.exitCode = status;
};
let capsule;
try {
  if (process.argv.length !== 2) throw new Error("ARGV_CARDINALITY");
  const argument = process.argv[1];
  if (
    argument.length === 0 ||
    argument.length > 24576 ||
    argument.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(argument)
  ) throw new Error("BASE64_FORM");
  const envelope = Buffer.from(argument, "base64");
  if (envelope.toString("base64") !== argument) throw new Error("BASE64_CANONICAL");
  const magic = Buffer.from("CESIUM_SUPPLY_INVERSE_ADAPTER_V2\n", "ascii");
  if (!envelope.subarray(0, magic.length).equals(magic)) throw new Error("MAGIC");
  const lengthEnd = envelope.indexOf(0x0a, magic.length);
  const hashEnd = lengthEnd < 0 ? -1 : envelope.indexOf(0x0a, lengthEnd + 1);
  if (lengthEnd < 0 || hashEnd < 0) throw new Error("HEADER");
  const lengthText = envelope.subarray(magic.length, lengthEnd).toString("ascii");
  const sha256 = envelope.subarray(lengthEnd + 1, hashEnd).toString("ascii");
  if (!/^(?:0|[1-9][0-9]*)$/.test(lengthText)) throw new Error("LENGTH_FORM");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("HASH_FORM");
  const source = envelope.subarray(hashEnd + 1);
  const bytes = Number(lengthText);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 18000 || source.length !== bytes) {
    throw new Error("BYTE_LENGTH");
  }
  if (source.length >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf) {
    throw new Error("BOM");
  }
  if (source.includes(0x0d) || source[source.length - 1] !== 0x0a) throw new Error("LINE_ENDING");
  new TextDecoder("utf-8", { fatal: true }).decode(source);
  if (createHash("sha256").update(source).digest("hex") !== sha256) throw new Error("HASH");
  const sourceBase64 = source.toString("base64");
  capsule = Object.freeze({
    argument,
    envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
    sourceBase64,
    bytes,
    sha256,
  });
  Object.defineProperty(globalThis, "__CESIUM_SUPPLY_INVERSE_ADAPTER_V2__", {
    value: capsule,
    writable: false,
    configurable: false,
    enumerable: false,
  });
} catch {
  fail(3, "CESIUM_ADAPTER_BOOTSTRAP_STRUCTURAL");
}
if (capsule !== undefined) {
  try {
    await import("data:text/javascript;base64," + capsule.sourceBase64);
  } catch {
    fail(2, "CESIUM_ADAPTER_RUNTIME_ERROR");
  }
}
~~~

Extracted exactly as specified, B2 is 2,591 bytes / 62 LF / zero CR / no terminal LF / SHA-256
71e5737a655440fc82541c938e5fc4356ed19c3c9ff8ae1be098f1009e95e50f.

The one import() in B2 is the only dynamic import in the outer chain. It receives only the
canonical, length-checked, SHA-checked source carried by value. A B2 validation failure imports
nothing and exits 3. An adapter evaluation failure exits 2. Those bootstrap-only failures occur
before a controlled evidence leaf exists and support no certification claim.

### 14.3 Exact direct argv shape and Windows feasibility

No shell, PowerShell, cmd.exe, redirection, response file, environment expansion, or mutable
script pathname may participate. The execution facility must call the absolute executable
directly with this six-element argument vector:

~~~text
executable: C:\Program Files\nodejs\node.exe
argv[0]: --no-addons
argv[1]: --no-warnings
argv[2]: --input-type=module
argv[3]: --eval
argv[4]: exact B2 bytes interpreted as UTF-8
argv[5]: the one exact canonical base64 adapter envelope
cwd: F:\Dev\GH\cesium-webgpu
stdin: ignored
shell: false
~~~

The executable remains 86,997,320 bytes / version 22.23.2 / SHA-256
0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4.
The direct launcher must construct a frozen minimal environment before Node startup, with
NODE_OPTIONS, NODE_PATH, npm injection variables, and preload/debug variables absent. The adapter
then requires the observed environment to equal that frozen map. B2 cannot retroactively prevent
a Node startup option, so the no-preload environment construction is part of the registered direct
launcher TCB. The later source-freeze record must enumerate every environment key/value; an added,
missing, or changed entry is STRUCTURAL.

Before release, the source-freeze record must retain B2 bytes/SHA, adapter source bytes/SHA, full
canonical envelope and base64 argument, every argv element, cwd, environment, direct-launch
facility identity, and the exact standard Win32 argv serialization. The serialized executable
plus command line, including quoting and terminal NUL, must be at most 30,000 UTF-16 code units,
below the 32,767-unit CreateProcessW boundary. Any runner that cannot pass this exact argv
directly, or any source that violates either size ceiling, leaves the gate NO-GO; a shell-based
fallback is forbidden.

Because the three sources do not yet exist, this V2 record deliberately contains no runnable
base64 argument. A future append-only source-freeze record at
migration_doc/RUST_PROCESS_SUPERVISOR_SUPPLY_CHAIN_DURABLE_INVERSE_SOURCE_FREEZE_2026-08-30.md
must register the fully instantiated values and receive independent unconditional GO before the
command exists. Session memory, a chat message, or root's command transcript is never authority.

## 15. Closed code-loading and import boundary

The future source review must prove the following exact static-import allowlists:

| Source | Allowed static built-ins |
| --- | --- |
| adapter | node:buffer, node:child_process, node:crypto, node:fs, node:path, node:stream, node:util |
| recorder | node:buffer, node:crypto, node:fs, node:path, node:url, node:worker_threads |
| predicate | node:buffer, node:crypto, node:worker_threads |

All three reviewed sources forbid import(), eval, Function, node:vm, createRequire, require,
process.dlopen, native addons, FFI, WebAssembly code execution, package imports, relative imports,
absolute/file-URL imports, network built-ins, fetch, shell construction, environment-selected code,
and execution of repository content. Repository and evidence bytes are data only.

There are exactly three narrow code-loading exceptions:

1. fixed B2 dynamically imports only its verified adapter data URL;
2. fixed R2, defined below, dynamically imports only its verified recorder data URL; and
3. the recorder constructs one Worker module data URL from the exact frozen-predicate buffer it
   has just read and hash-verified.

The adapter alone may statically import node:child_process. It may call only spawn, exactly once,
to launch the absolute registered Node executable with R2 and the recorder envelope described
below. exec, execFile, fork, spawnSync, execSync, execFileSync, shell:true, detached:true, another
executable, and a second child are forbidden. Recorder and predicate import no child-process API,
launch no process, open no socket, and write no filesystem path.

R2 is mechanically B2 with exactly these four literal substitutions and no other byte change:

~~~text
CESIUM_SUPPLY_INVERSE_ADAPTER_V2 -> CESIUM_SUPPLY_INVERSE_RECORDER_V2
__CESIUM_SUPPLY_INVERSE_ADAPTER_V2__ -> __CESIUM_SUPPLY_INVERSE_RECORDER_V2__
CESIUM_ADAPTER_BOOTSTRAP_STRUCTURAL -> CESIUM_RECORDER_BOOTSTRAP_STRUCTURAL
CESIUM_ADAPTER_RUNTIME_ERROR -> CESIUM_RECORDER_RUNTIME_ERROR
~~~

That derivation yields exact R2 identity 2,595 bytes / 62 LF / zero CR / no terminal LF /
SHA-256 6adf5664af7b8ec8d512bad6f505accd42811d3f7f169acf6f3b39caec44677a.

The adapter constructs the canonical recorder envelope from the byte buffer read back from
frozen/recorder.mjs, using the R2 magic, decimal length, lowercase SHA-256, and exact source bytes.
The recorder source has the same 1-through-18,000-byte and UTF-8/LF restrictions as the adapter.
The adapter requires canonical base64 at most 24,576 characters and direct Win32 serialization at
most 30,000 UTF-16 code units. The child argv has the same six-element flag shape as section 14.3,
with R2 at argv[4] and the recorder envelope at argv[5], cwd equal to the V2 evidence leaf, stdin
ignored, shell false, detached false, windowsHide true, and stdout/stderr piped.

No Node module load opens either the live recorder path or frozen/recorder.mjs. The exact bytes
read from the create-new frozen copy are passed by value through R2. The recorder reads
frozen/predicate.mjs once, checks its registered byte count/SHA and strict text form, and supplies
that retained buffer by data URL to its sole Worker. A later path change cannot alter executed
recorder or predicate bytes; any frozen-file post-run drift is independently STRUCTURAL.
Launching the read-back buffer by value is the sole meaning of launching the frozen recorder
copy; the live source buffer and both mutable pathnames are ineligible launch inputs.

## 16. Adapter-owned lifecycle and durable child observation

### 16.1 Exclusive acquisition and source freeze

The adapter performs these ordered steps and records the completed stage:

1. Validate the immutable launch capsule, exact process.argv and process.execArgv shapes, absolute
   process.execPath/cwd, sanitized environment, B2/R2 registrations, adapter envelope, executable
   byte identity, and V2 preregistration identity. No repository content is interpreted as code.
2. Validate the existing output parent as a non-reparse directory, then create the exact V2 leaf
   with one nonrecursive exclusive mkdir. EEXIST or any alias/reparse/non-directory fact is a
   STRUCTURAL preflight refusal; the adapter does not touch the colliding path and no run exists.
3. Inside the acquired leaf, immediately open receipt.json with create-new semantics and retain
   that descriptor. It remains zero-length until one complete terminal JSON value is ready. Open
   every adapter-owned raw sink with create-new semantics before child launch. A failure after
   leaf acquisition is caught and folded into a durable receipt when the retained descriptor is
   writable; a zero-length, partial, duplicate, or absent receipt never supports a claim.
4. Materialize adapter-bootstrap.mjs, adapter-envelope.b64, adapter-invocation.json,
   frozen/adapter.mjs, and executor.before.json from B2, the launch capsule, and directly observed
   process state. The stored base64 file is the exact argv[5] bytes plus one LF, with the LF
   explicitly excluded from the argument hash.
5. Open each live recorder and predicate source exactly once, reject reparse/nonregular or
   unstable pre/post-fstat identity, read one bounded buffer, verify the later source-freeze
   bytes/SHA and strict UTF-8/LF form, and close the source handle. Those same buffers create
   frozen/recorder.mjs and frozen/predicate.mjs with create-new writes, flush, close, and read-back
   verification. The adapter never executes or imports a live source pathname.
6. Read back frozen/recorder.mjs once into the exact buffer used to construct the R2 envelope.
   Write recorder-bootstrap.mjs, recorder-envelope.b64, and recorder-child.argv.json before spawn.
   The latter retains the full exact executable, all six argv elements, cwd, environment,
   stdio/shell/detached/windowsHide options, launch nonce, source hashes, and serialized Win32
   command-line length.

The adapter source's physical live path is separately read as data for the before/after
first-party census and must equal the by-value adapter bytes. It is never the load source.

### 16.2 Adapter-owned request and sole child

Before spawn, the adapter writes request.json create-new. It binds the launch nonce; all thirteen
registered live input rows; the refreshed lock/config identities; full vendor, metadata, resolver,
executor, Cargo, rustc, and first-party identities; the exact canonical/mutant registrations; the
frozen source hashes; the sole frozen predicate path; and every expected control/result field.
The recorder may read only request.json and frozen/predicate.mjs under its exact cwd. It may not
write the leaf or read another repository path.

The adapter pre-opens recorder-child.stdout.bin and recorder-child.stderr.bin with create-new
semantics, then performs its one spawn. It retains the exact ChildProcess object and its
Node-owned process handle through terminal close; it never reacquires the child by PID. It records
child.pid, handleBindingKind=node-child-process-object-retained, launch nonce, spawn/error/exit/
close event order, raw Node exitCode and signalCode, UTC start/end strings, monotonic nanosecond
start/end values, timeout and kill calls/results, reap result, and both pipe close/drain results in
recorder-child.observation.json. No numeric kernel-handle claim is made because supported Node
does not expose one.

Every stdout/stderr chunk observed on the retained child pipes is written unmodified to the
already-open raw sink before being counted as consumed. The adapter simultaneously retains a
bounded parse buffer. Each stream cap is 16 MiB. Crossing a cap stops acceptance, marks the stream
incomplete, initiates termination, and folds ERROR; it never silently truncates into PASS or FAIL.
The raw files remain as physically observed prefixes with exact byte/hash and completeness facts.

The recorder's stdout protocol is exactly one strict UTF-8, LF-terminated JSON value and no other
byte; deliberate stderr is empty. The result carries its status/exit, callback observations,
identity results, canonical-validator calls, and base64 plus byte/hash/completeness fields for the
predicate Worker's stdout/stderr. After the child closes and both raw streams drain, the adapter
schema-validates the exact stdout bytes and writes them byte-for-byte as result.json. It decodes
the registered predicate streams into predicate.stdout.bin and predicate.stderr.bin and verifies
their declared identities. Extra JSON, trailing bytes, an unexpected stderr byte, invalid base64,
or a result/observed-exit mismatch is STRUCTURAL.

### 16.3 Bounded timeout, termination, reap, and drain

All deadlines use monotonic time and are absolute, never reset by progress:

| Boundary | Exact deadline/action |
| --- | --- |
| predicate Worker | 20,000 ms from Worker start |
| recorder Worker termination/reap | 3,000 ms after Worker deadline or fault |
| recorder Worker stream drain | 2,000 ms after Worker terminal state |
| recorder child | 35,000 ms from adapter spawn return |
| child graceful termination/reap | 3,000 ms after child deadline |
| child forced termination/reap | a further 2,000 ms |
| child-pipe drain/destruction | 3,000 ms after child close or final kill deadline |
| adapter controlled finalization | 60,000 ms from successful evidence-leaf acquisition |
| root adapter hard stop | 75,000 ms from direct adapter spawn, then kill and 5,000 ms bounded reap |

The recorder owns only its Worker; the adapter owns only the recorder ChildProcess object; root
owns only the adapter process handle. A timeout, failed kill, failed reap, incomplete drain,
unresolved close event, or root hard stop is ERROR and prohibits evidence freeze as PASS/FAIL.
Root retains any partial leaf and never reruns into it. V2 makes no zero-survivor, Job-object,
process-group, or descendant-containment claim.

## 17. Same-validator positive control and registered inverses

The predicate implements one canonical-byte validator function and records one stable validator
identifier for every call. That exact function, with no mode flag or alternate call path, must:

1. accept the exact current thirteen-row stream as 1,312 bytes /
   a3ab97284316b0c09edc271ae440dc92db0f7956e7d44e4a22ebcae1d8c762a6;
2. reject the first-two-rows-swapped 1,312-byte stream /
   f69dbb979a02e48c4ae32b889a9d286ebd344678d5863136f10e408245805aca
   with reason NON_ORDINAL_ORDER;
3. reject the first-TAB-to-space 1,312-byte stream /
   b34460cce801853530142c41dd54b21657f20ec950f7b65aeaf9db117eb6327f
   with reason BAD_SEPARATOR; and
4. reject the terminal-LF-removed 1,311-byte stream /
   1e091b3b84c79225a0dc8388ca3aed3088782411529c641fea96713e38e46d90
   with reason MISSING_TERMINAL_LF.

The validator enforces strict UTF-8 with no BOM/CR, exactly thirteen unique logical paths,
forward slashes, two TABs per row, canonical decimal lengths, lowercase 64-hex hashes, ordinal
path order, and one terminal LF. It also regenerates the stream from the supplied row objects and
requires byte equality. The result records input bytes/SHA, accepted boolean, reason, row count,
and validator identifier for all four calls.

An always-reject validator fails item 1 and is STRUCTURAL. An always-accept validator fails items
2 through 4 and is STRUCTURAL. The config and stale-lock tuple streams remain well-formed
canonical streams and must be accepted by this same syntax validator before the separate identity
gate rejects them; syntax rejection cannot masquerade as a biting supply-chain inverse.

The current exact inverse registrations remain:

| Inverse | Mutated file identity | Current thirteen-row tuple | Required gate/canary result |
| --- | --- | --- | --- |
| config offset-0 XOR 0x01, 0x5b to 0x5a | 123 bytes / 3d00279785e55a40d6e5f702d91810965b00a438bafc265fa3333d7f0a36d782 | c456f53797584d1c97f82876579e2af828e731802b968c33874655a39663fcbd | accepted=false; launch_permitted=false; exactly .cargo/config.toml mismatches; fresh callback 0 to 0 |
| exact three-literal stale lock, 34 bytes removed | 6,575 bytes / f786d3ec5ae18179b94b2710d9a565c33843e9db4546a65e28488c3f50822023 | 1d2d869032320fb50ac7f23b2fbaba480820e8f3aebf7b344952d25de20cfb58 | accepted=false; launch_permitted=false; exactly Cargo.lock mismatches; fresh callback 0 to 0 |

The unchanged live tuple must pass the same identity gate and invoke its fresh test-owned,
side-effect-free callback exactly 0 to 1. The two inverse callbacks are distinct fresh objects.
The callback exists only to demonstrate authorization topology and cannot launch a process,
Worker, import, file write, or network action.

V1's inert/no-op mutation, live-file mutation detector, launch-callback bypass, callback overfire,
and tuple-substitution controls remain mandatory. In addition, a synthetic checker mutant that
routes the three malformed byte streams around the registered validator must bite, and a mutant
that routes either real inverse directly to the callback must bite before the callback. Any
detector, validator, callback, or routing self-control that does not discriminate is STRUCTURAL,
not a scorable real-mutant result.

The historical-prefix identities remain provenance only:

~~~text
historical subject prefix: 184,665 / 49d84f2b50a214019fcd00815d89469d6871471691fb9c03c88db834d4eb926b
historical current tuple: 1,312 / c1abf90fc4f3eaea63c4fb3e3be8d219bd1028cc1e09f319bc7173061c81ca6f
historical config tuple: 31e296d0c3faa19094199aae094a038189ac43ba96d8e2749988500cb6008d42
historical stale-lock tuple: 0dc0af2a59ef246d207881d7bfa3beeca6abe7dcf9ba76d37e8cc24eca1c30ae
~~~

The withdrawn temporary-array enumeration error is an audit incident, not a subject defect and
not an acceptance identity.

## 18. Adapter-owned no-mutation census

The exact thirteen current input identities and canonical grammar in V1 section 4 remain the V2
acceptance values. The adapter, not the recorder, constructs inputs.before.tsv before child spawn
and inputs.after.tsv after terminal child observation. Both streams must be byte-identical to the
registered 1,312-byte /
a3ab97284316b0c09edc271ae440dc92db0f7956e7d44e4a22ebcae1d8c762a6 current stream and to each
other.

The adapter also constructs and retains:

- vendor.before.tsv and vendor.after.tsv: all 1,383 regular vendor files, 30,423,571 aggregate
  bytes, canonical tree SHA-256 ca954a20ea857cc4e43e965d505671d56bcd9184095309311b66482d036f1f05;
- first-party.before.tsv and first-party.after.tsv: every regular file under
  Tools/process-supervisor except vendor, target, and output, plus this complete V2
  preregistration and the future source-freeze record as explicit external governance rows;
- toolchain.before.tsv and toolchain.after.tsv: exact Node, Cargo, and rustc executable byte
  identities registered in V1/V2; and
- the exact retained metadata stdout/stderr copies and their identities from V1 section 5.

The first-party census now explicitly includes all three future tool sources. The source buffers
used in its before rows are the same buffers checked during source freeze; the after pass reopens
the three live paths once as data. Added/deleted rows, content change, normalized-path collision,
reparse/symlink/nonregular input, unstable fstat, unreadable byte, tuple difference, metadata
difference, toolchain difference, or any pre/post manifest difference is STRUCTURAL.

The adapter parses the retained metadata as data only and must reproduce 32 packages, 25 registry
packages, seven workspace members, the lock registry/checksum set, and the 25 vendor directory
identities with zero set difference. It never invokes Node beyond the registered adapter/recorder,
and never invokes Cargo, rustc, rustup, a build script, proc macro, test, product, browser, shell,
or network operation. All config and stale-lock mutation occurs only on independent in-memory
Buffer copies.

## 19. Exact V2 artifact topology and noncircular receipt

After successful leaf acquisition, the adapter reserves create-new handles for this fixed set.
Every controlled terminal path closes and retains every name; a stage that has no value writes a
schema-valid unavailable record or a zero-length binary/TSV and the receipt marks it incomplete.
No missing value can fold PASS or FAIL.

| Artifact | Owner and binding |
| --- | --- |
| adapter-bootstrap.mjs | exact B2 argv bytes |
| adapter-envelope.b64 | exact adapter argv[5] plus one excluded terminal LF |
| adapter-invocation.json | observed argv/execArgv/cwd/environment/capsule and direct-launch assertions |
| executor.before.json / executor.after.json | absolute Node path, bytes, version, SHA, and pre/post equality |
| frozen/adapter.mjs | exact decoded by-value source |
| frozen/recorder.mjs | exact verified live recorder buffer |
| frozen/predicate.mjs | exact verified live predicate buffer |
| source-freeze.tsv | registered and observed bytes/SHA for B2, R2, and all three sources |
| request.json | immutable recorder request, V2/source-freeze identities, and every registered identity/control |
| metadata.stdout.json / metadata.stderr.bin | exact copied retained metadata streams |
| inputs.before.tsv / inputs.after.tsv | complete thirteen-row manifests |
| vendor.before.tsv / vendor.after.tsv | complete 1,383-row manifests |
| first-party.before.tsv / first-party.after.tsv | complete first-party manifests including three sources, V2, and source-freeze records |
| toolchain.before.tsv / toolchain.after.tsv | exact Node/Cargo/rustc inert-byte identities |
| recorder-bootstrap.mjs | exact R2 child argv bytes |
| recorder-envelope.b64 | exact child argv[5] plus one excluded terminal LF |
| recorder-child.argv.json | full executable/argv/cwd/env/options/nonce and Win32 serialized-length facts |
| recorder-child.stdout.bin / recorder-child.stderr.bin | adapter-observed raw pipe bytes |
| recorder-child.observation.json | PID/object binding, event order, exit/signal/timeouts/kills/reap/drain and raw-stream identities |
| result.json | exact schema-validated recorder stdout bytes |
| predicate.stdout.bin / predicate.stderr.bin | exact Worker streams decoded from validated result fields |
| artifact-manifest.tsv | path, decimal bytes, lowercase SHA-256 for every earlier closed artifact |
| receipt.json | terminal aggregate, manifest identity, allowed path-set identity, lifecycle, predicates, no-mutation, and claim limits |

The adapter creates frozen as the only child directory. No scratch, temporary, lock, alternate
receipt, or sidecar path is allowed inside or outside the leaf. The recorder and predicate write
none of these files.

The fixed allowed-name set has 32 entries: the 31 regular files obtained by expanding every paired
table row and the one directory frozen/. Its canonical serialization is each entry as
type-letter D or F, one TAB, its forward-slash relative path, and LF, sorted by ordinal comparison.
That serialization is 711 bytes / SHA-256
eacb74037016e3b47eee4525b5027b85dd913d9d5c2a5db05c1d038eabff901a. The artifact manifest has
exactly 29 rows because it excludes the directory, itself, and receipt.json.

All artifacts except artifact-manifest.tsv and receipt.json are flushed, closed, and re-read
before the manifest is written. The manifest uses ordinal forward-slash paths and terminal LF; it
excludes itself and receipt.json to avoid a hash cycle. The receipt records the manifest
bytes/SHA, row count, and exact allowed-name-set SHA, then is written once through the retained
descriptor, flushed, closed, and never reopened by the adapter. A later physical reviewer hashes
the manifest and receipt independently and rejects missing, extra, changed, nonregular, linked,
reparse, partial, or open entries.

The receipt binds B2/R2, all source and envelope hashes, both full argv records, executor
pre/post identity, launch nonce, child PID/object-handle kind, raw child streams, observed
exit/signal, result, predicate streams, censuses, metadata, manifest, reason set, final status,
and intended adapter exit. Recorder self-report alone cannot supply any child lifecycle or raw
pipe fact. Adapter console bytes and root session output are explicitly outside the manifest.

## 20. V2 terminal fold and controlled-failure rule

The adapter folds every applicable observation once by maximum severity on the immutable order
PASS / 0 < FAIL / 1 < ERROR / 2 < STRUCTURAL / 3:

1. STRUCTURAL / 3: bootstrap/source/executor/preregistration/request drift; invalid or incomplete
   provenance, schema, canonical-validator control, detector control, evidence topology, receipt,
   manifest, no-mutation census, metadata/resolver/vendor equality, launch argv, result-to-observed
   exit binding, frozen-copy identity, or reparse/nonregular boundary.
2. ERROR / 2: adapter/recorder/Worker exception after valid prerequisites; I/O failure; timeout;
   stream cap; incomplete drain; failed termination/reap; abnormal child terminal event not
   explained by a valid result; or inability to complete a valid measurement.
3. FAIL / 1: a complete, structurally valid measurement in which either registered real inverse
   is accepted, launch-permitted, reaches its callback, reports the wrong sole mismatch, or misses
   its exact registered file/tuple identity.
4. PASS / 0: all provenance/topology/lifecycle facts are complete; the same validator accepts the
   exact current canonical stream and rejects all three malformed streams; all self-controls bite;
   the unchanged live gate calls its callback exactly once; both real inverses reject before fresh
   callbacks at 0 to 0; all pre/post bytes match; and nothing is unscored.

A valid measured red is never demoted or quarantined. A partial run is never FAIL or PASS.
STRUCTURAL outranks concurrent ERROR, and a lower status cannot overwrite a higher one.

Successful exclusive leaf acquisition defines the beginning of a controlled run. From then on,
every caught terminal path must produce the fixed artifacts, manifest, and a complete receipt.
Failure before leaf acquisition, including B2 refusal or leaf collision, is a preflight refusal:
it must not touch an existing leaf, creates no evidence run, and leaves the gate NO-GO. An
uncaught crash, root hard stop, or missing/partial receipt is operationally ERROR but physically
uncertifiable; root retains the partial leaf and does not freeze or rerun it.

On a controlled terminal path, the adapter sets its intended process.exitCode to the receipt exit
only after every file is closed. Root's directly observed adapter exit must match in the same
session or root refuses freeze. The durable claim remains limited to the recorder child envelope;
loss of root's transient cross-check after a successful freeze does not turn recorder-authored
bytes into outer evidence.

## 21. V2 freeze, source release, execution, and review order

The order is strict:

1. Freeze this complete append-only V2 record. Verify both the preserved 26,451-byte V1 prefix and
   the new full-file tuple. Obtain two new independent unconditional record-review GOs: one for
   B2/R2, adapter identity, child lifecycle, raw evidence, timeout/reap, create-new topology, and
   noncircular durability; one for the predicate, same-validator controls, registered identities,
   censuses, provenance, status fold, and claim boundary. Mithrellas and Pengolodh cannot approve
   V2.
2. Only after both V2 GOs may root separately release authoring of the three named source files.
   This record itself grants no source-creation authority. Authors run no inverse, Cargo, build,
   test, product, browser, or network operation.
3. Freeze the three source tuples and the exact B2/R2/envelope/argv/environment/Win32-serialization
   instantiation in the named source-freeze record. Obtain fresh independent unconditional
   source/security and evidence-lifecycle GOs. Review must prove the allowlists, by-value loads,
   sole child/Worker topology, exact size limits, and every negative control are load-bearing.
4. Root terminally rehashes V2, the source freeze, three sources, exact thirteen inputs, metadata,
   vendor, Node/Cargo/rustc, and first-party boundary; freezes every Rust lane; confirms both V1
   and V2 leaves are absent; confirms direct no-shell argv support; and releases the V2 invocation
   exactly once.
5. Root waits under the 75-second outer deadline, performs the exit cross-check, and freezes the
   complete V2 leaf only when the adapter closed a complete receipt and the cross-check matches.
   Every nonmatching, timeout, collision, partial, or controlled non-PASS outcome is retained and
   never rerun into the same leaf.
6. A fresh physical reviewer who was neither record reviewer, source author/reviewer, nor executor
   reads the retained B2/R2/source bytes and all artifacts; terminally rehashes every path;
   reconstructs both real and all instrument mutants in memory; independently recomputes the
   status fold and canonical manifests; verifies child raw streams/exit against result and
   receipt; and returns unconditional GO or NO-GO without execution or edit.

Conditional GO is NO-GO. Drift at any boundary invalidates only downstream authority and requires
a new append-only registration, new leaf name, and fresh reviews. No cleanup deletes or rewrites a
failed evidence directory.

## 22. V2 claim boundary and continuing hold

If and only if the future V2 receipt is PASS and the fresh physical review is unconditional GO,
the durable claim is limited to this statement: on the exact registered Windows, Node, B2/R2,
three-source, thirteen-input, metadata, vendor, toolchain, and governance tuple, the reviewed
byte-bound adapter actually observed the reviewed byte-bound recorder child; the same predicate
validator accepted the exact canonical current tuple and rejected its malformed encodings; both
registered in-memory supply-chain inverses were rejected before their test-owned callbacks; and
the registered live boundaries remained byte-identical.

V2 does not prove the adapter's own outer exit after session loss, independent cryptographic
attestation, hostile same-account filesystem resistance, immutable Node executable-to-open
identity, dependency safety, licensing, a fresh Cargo resolver/compiler run, buildability, test or
product behavior, process containment, zero survivors, Q-152 behavior, Linux/macOS behavior,
release readiness, or Rust-tool certification. It is not user-facing process-supervisor
documentation.

The supply-chain/Cargo gate remains **NO-GO** until V2 receives both new record GOs, all three
sources and the fully instantiated by-value runner receive their own GOs, root executes once,
artifacts freeze, and a fresh independent physical review returns unconditional GO. Only root may
then release a separately preregistered Cargo/build/test tranche. Documentation for the Rust tool
may be written only after the relevant behavior is certified, with claims limited to that
evidence. This append grants no execution, Cargo, Git, browser, network, build, test, or source
authority.

## 23. Append-only V3 authority and preserved V2 failure

Sections 1 through 22 are the immutable V2 prefix: exactly 63,359 bytes / SHA-256
be2f2ea6799499a87f2ace7801507470e2e84f6283132f6da4a464ea35ae5ec8 / 990 LF / zero CR /
no UTF-8 BOM / terminal LF. Its first 26,451 bytes remain the V1 hash registered in section 12.
V3 changes no prior byte and does not convert either prior review into evidence.

Cirdan and Aredhel independently returned terminal **NO-GO** on V2. Their combined blockers, also
accepted by root, are:

1. V2 repeated a false 184,665-byte historical-prefix hash.
2. B2/R2 decoded unvalidated header bytes with the permissive ASCII decoder, so high-bit aliases
   could become valid decimal or lowercase-hex characters before the regex checks.
3. V2 required an unavailable direct root argv facility and therefore had no actually executable
   outer launch topology.

V3 supersedes V2's historical-prefix claim, B2/R2, direct-root launch premise, three-source
topology, evidence-leaf ownership, deadlines, census, artifact topology, receipts, claim boundary,
and release order. V1/V2 paths and leaves remain unauthorized and absent. V3 itself authorizes no
source creation or execution.

## 24. Corrected historical-prefix provenance and biting control

The first 184,665 physical bytes of the frozen subject are LF-only strict UTF-8 with 1,776 LF,
zero CR, no BOM, terminal LF, and exact SHA-256:

~~~text
49d84f2b35f27c063c8c69dceae91ad29ba41162216cc9efa2ffe7f8ed449486
~~~

This value explicitly supersedes the false V2 value
49d84f2b50a214019fcd00815d89469d6871471691fb9c03c88db834d4eb926b everywhere. The false value
is retained only as an incident mutant; it is never provenance or acceptance authority. The
current full subject remains 195,674 bytes /
f7157f11b7e63e2228cf851b3b6edec30168817c9291eee2f1ac9c27201bbcb2.

The same provenance verifier receives the exact 184,665-byte buffer twice:

- positive: corrected expected hash above; it must accept and report the corrected observed hash;
- false-claim mutant: unchanged bytes plus the false V2 expected hash; it must reject exactly
  HISTORICAL_PREFIX_HASH_MISMATCH, report zero changed subject bytes, and report corrected observed
  hash versus false expected hash.

An always-accept or always-reject provenance verifier is STRUCTURAL. The false-claim mutant runs
on an in-memory expected-hash record only; it never edits the subject. The historical tuple values
c1abf90fc4f3eaea63c4fb3e3be8d219bd1028cc1e09f319bc7173061c81ca6f,
31e296d0c3faa19094199aae094a038189ac43ba96d8e2749988500cb6008d42, and
0dc0af2a59ef246d207881d7bfa3beeca6abe7dcf9ba76d37e8cc24eca1c30ae remain provenance only.

## 25. Strict byte-level bootstraps B3 and R3

### 25.1 Exact B3 bytes

B3 replaces B2. B3 is exactly the UTF-8 text inside the next fence, excluding the fences, joined
with LF, with no CR, BOM, or terminal LF:

~~~js
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
const fail = (status, line) => {
  process.stderr.write(line + "\n");
  process.exitCode = status;
};
let capsule;
try {
  if (process.argv.length !== 2) throw new Error("ARGV_CARDINALITY");
  const argument = process.argv[1];
  if (
    argument.length === 0 ||
    argument.length > 24576 ||
    argument.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(argument)
  ) throw new Error("BASE64_FORM");
  const envelope = Buffer.from(argument, "base64");
  if (envelope.toString("base64") !== argument) throw new Error("BASE64_CANONICAL");
  const magic = Buffer.from("CESIUM_SUPPLY_INVERSE_ADAPTER_V3\n", "ascii");
  if (!envelope.subarray(0, magic.length).equals(magic)) throw new Error("MAGIC");
  const lengthEnd = envelope.indexOf(0x0a, magic.length);
  const hashEnd = lengthEnd < 0 ? -1 : envelope.indexOf(0x0a, lengthEnd + 1);
  if (lengthEnd < 0 || hashEnd < 0) throw new Error("HEADER");
  const lengthBytes = envelope.subarray(magic.length, lengthEnd);
  if (lengthBytes.length === 0) throw new Error("LENGTH_EMPTY");
  if (lengthBytes.length > 1 && lengthBytes[0] === 0x30) throw new Error("LENGTH_LEADING_ZERO");
  let bytes = 0;
  for (const value of lengthBytes) {
    if (value < 0x30 || value > 0x39) throw new Error("LENGTH_BYTE");
    bytes = bytes * 10 + value - 0x30;
    if (!Number.isSafeInteger(bytes) || bytes > 18000) throw new Error("BYTE_LENGTH");
  }
  if (bytes < 1) throw new Error("BYTE_LENGTH");
  const hashBytes = envelope.subarray(lengthEnd + 1, hashEnd);
  if (hashBytes.length !== 64) throw new Error("HASH_LENGTH");
  for (const value of hashBytes) {
    const digit = value >= 0x30 && value <= 0x39;
    const lowerHex = value >= 0x61 && value <= 0x66;
    if (!digit && !lowerHex) throw new Error("HASH_BYTE");
  }
  const sha256 = hashBytes.toString("ascii");
  const source = envelope.subarray(hashEnd + 1);
  if (source.length !== bytes) throw new Error("SOURCE_LENGTH");
  if (source.length >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf) {
    throw new Error("BOM");
  }
  if (source.includes(0x0d) || source[source.length - 1] !== 0x0a) throw new Error("LINE_ENDING");
  new TextDecoder("utf-8", { fatal: true }).decode(source);
  if (createHash("sha256").update(source).digest("hex") !== sha256) throw new Error("HASH");
  const rebuilt = Buffer.concat([
    magic,
    Buffer.from(String(bytes), "ascii"),
    Buffer.of(0x0a),
    Buffer.from(sha256, "ascii"),
    Buffer.of(0x0a),
    source,
  ]);
  if (!rebuilt.equals(envelope)) throw new Error("HEADER_RESERIALIZE");
  const sourceBase64 = source.toString("base64");
  capsule = Object.freeze({
    argument,
    envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
    headerSha256: createHash("sha256").update(envelope.subarray(0, hashEnd + 1)).digest("hex"),
    sourceBase64,
    bytes,
    sha256,
  });
  Object.defineProperty(globalThis, "__CESIUM_SUPPLY_INVERSE_ADAPTER_V3__", {
    value: capsule,
    writable: false,
    configurable: false,
    enumerable: false,
  });
} catch (error) {
  const reason = error instanceof Error ? error.message : "UNKNOWN";
  fail(3, "CESIUM_ADAPTER_BOOTSTRAP_STRUCTURAL:" + reason);
}
if (capsule !== undefined) {
  try {
    await import("data:text/javascript;base64," + capsule.sourceBase64);
  } catch {
    fail(2, "CESIUM_ADAPTER_RUNTIME_ERROR");
  }
}
~~~

The header decoder never converts a byte until it has proved that the byte is exact 7-bit ASCII.
Decimal permits only bytes 0x30 through 0x39 with canonical no-leading-zero form. SHA-256 permits
exactly 64 bytes in 0x30 through 0x39 or 0x61 through 0x66. The complete header and source are then
reserialized and compared byte-for-byte with the decoded envelope before the sole data-URL import.

R3 is B3 with exactly these four literal substitutions and no other change:

~~~text
CESIUM_SUPPLY_INVERSE_ADAPTER_V3 -> CESIUM_SUPPLY_INVERSE_RECORDER_V3
__CESIUM_SUPPLY_INVERSE_ADAPTER_V3__ -> __CESIUM_SUPPLY_INVERSE_RECORDER_V3__
CESIUM_ADAPTER_BOOTSTRAP_STRUCTURAL -> CESIUM_RECORDER_BOOTSTRAP_STRUCTURAL
CESIUM_ADAPTER_RUNTIME_ERROR -> CESIUM_RECORDER_RUNTIME_ERROR
~~~

### 25.2 Fixed high-bit alias controls

The bootstrap controls use exact inert source bytes ASCII export-default-zero-semicolon-LF:
18 bytes / base64 ZXhwb3J0IGRlZmF1bHQgMDsK / SHA-256
9a15b5aa00cb010b885ffae3d28ab390fe0f8a9df7f47f30fd719ace8ed203b1. With the adapter V3 magic,
the canonical envelope is 119 bytes /
86171b4dc4e3083a952b2315aff20d18a7cafcf0fff8fcaa1458ab3271950f49 and its 160-character
canonical base64 argument has SHA-256
f008ebea0cd1a84006acdbab9b8e7d69dae383aa3ccca3a72d076e0c0ac7a163.

The exact mutants are:

| Mutant | One byte | Envelope SHA-256 | Base64-argument SHA-256 | Required result |
| --- | --- | --- | --- | --- |
| length high-bit alias | offset 33, 0x31 to 0xb1 | fac2057a9b6bd6bf5de00eafa1d51805151374640836426900d95253dfae5bb4 | 002069f5bf860c992e6788e80f6aa2e4ccbbab4de2cf38938c0198444ddd8775 | reject LENGTH_BYTE before import |
| hash high-bit alias | offset 36, 0x39 to 0xb9 | a7232f5ebea554dff905b6d6c8eb010c3ef6574cb3ca7667d802e17d3d722cd0 | 98e36c6d94fa98084621c248c1d8c7ff61ba03ef03395f9dc3dbf5dfe1a86c67 | reject HASH_BYTE before import |

The canonical fixture must be accepted by the same byte-level envelope validator. Both mutants
retain envelope length and all nonselected bytes. An always-reject, always-accept, high-bit-masking,
string-first, or missing-reserialization bootstrap mutant must bite in the future source/security
review. These controls execute no repository content and grant no run authority.

## 26. Actually available four-source launch topology

### 26.1 Exact fourth source and new leaf

V3 registers four future reviewed sources:

~~~text
Tools/process-supervisor/tools/supply-chain-durable-inverse-launcher.mjs
Tools/process-supervisor/tools/supply-chain-durable-inverse-adapter.mjs
Tools/process-supervisor/tools/supply-chain-durable-inverse-recorder.mjs
Tools/process-supervisor/tools/supply-chain-durable-inverse-predicate.mjs
~~~

It registers exactly one future V3 evidence leaf:

~~~text
Tools/process-supervisor/output/supply-chain-durable-inverse-2026-08-30-v3/
~~~

The new source-freeze authority path is:

~~~text
migration_doc/RUST_PROCESS_SUPERVISOR_SUPPLY_CHAIN_DURABLE_INVERSE_V3_SOURCE_FREEZE_2026-08-30.md
~~~

The launcher, all other sources, the authority record, and the V3 leaf were absent at the V3
collision audit. That fact is checked again before any later source write or run.

### 26.2 Exact available outer shell S3

The actually available outer shell is:

~~~text
C:\Program Files\PowerShell\7\pwsh.exe
301,368 bytes
PowerShell 7.6.5 / file version 7.6.5.500
SHA-256 362a356ce7f0940ec74f73a8fc2c990a2cc24a38a11c90bbd8eca947110ad139
~~~

Root's actually available execution facility must select that exact shell with login disabled and
pass -Command followed by exact S3. It does not provide durable proof of additional PowerShell
startup/profile flags, so V3 does not preregister or claim -NoLogo, -NoProfile, or -NonInteractive.
Any startup/profile behavior before S3 is part of the explicit outer shell TCB. S3 is the UTF-8
text inside the next fence, excluding the fences, joined with LF, with no CR, BOM, or terminal LF:

The execution facility must set the literal working directory
F:\Dev\GH\cesium-webgpu before shell creation; the launcher validates that exact process.cwd().

~~~powershell
$ErrorActionPreference = "Stop"
$env:NODE_OPTIONS = $null
$env:NODE_PATH = $null
$env:NODE_REPL_EXTERNAL_MODULE = $null
$env:NODE_V8_COVERAGE = $null
$env:NODE_EXTRA_CA_CERTS = $null
$env:NODE_INSPECT_RESUME_ON_START = $null
$env:NODE_COMPILE_CACHE = $null
$env:NODE_REDIRECT_WARNINGS = $null
$env:NODE_ICU_DATA = $null
$env:NODE_DEBUG = $null
$env:NODE_DEBUG_NATIVE = $null
$env:NPM_CONFIG_NODE_OPTIONS = $null
$env:OPENSSL_CONF = $null
$env:SSL_CERT_DIR = $null
$env:SSL_CERT_FILE = $null
& "C:\Program Files\nodejs\node.exe" "--no-addons" "--no-warnings" "F:\Dev\GH\cesium-webgpu\Tools\process-supervisor\tools\supply-chain-durable-inverse-launcher.mjs"
exit $LASTEXITCODE
~~~

The command contains only fixed syntax, fixed environment-key removals, fixed flags, and literal
absolute executable/script paths. No repository byte, prompt text, environment value, generated
path, wildcard, substitution, eval, response file, pipe, redirection, or attacker-controlled
interpolation enters a path or argument. LASTEXITCODE is used only after the synchronous literal
Node invocation and can affect only the shell exit.

Node remains the exact 86,997,320-byte / version 22.23.2 /
0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4 executable. Its only
application argument in S3 is the fixed launcher pathname. The command is short and does not rely
on the Win32 32,767-unit by-value boundary.

This topology intentionally does **not** claim direct root-to-adapter launch. PowerShell, its
command parser, the absolute Node pathname, Node's opening of the launcher pathname, the live
launcher file, and the root execution facility are an explicit outer TCB. A same-account actor
could replace a pathname between root's hash and an OS open. Pre/post hashes detect drift but do
not prove same-object execution. If that residual boundary is unacceptable for the narrow claim,
the gate remains NO-GO; V3 does not relabel it as immunity.

### 26.3 Launcher-to-adapter by-value boundary

The reviewed launcher is the exclusive V3 evidence-leaf owner. After acquiring the leaf, it reads
its own live source as data for a source-freeze comparison, but makes no self-attestation claim.
It opens the adapter live source exactly once, rejects nonregular/reparse/unstable identity, reads
one bounded buffer, verifies the registered byte count/SHA and strict UTF-8/LF form, and writes
frozen/adapter.mjs create-new from that same buffer.

The launcher constructs the canonical adapter V3 envelope from that retained verified buffer. It
spawns exactly one adapter child using node:child_process.spawn with:

~~~text
executable: C:\Program Files\nodejs\node.exe
argv: --no-addons, --no-warnings, --input-type=module, --eval, exact B3, exact adapter envelope
cwd: exact V3 evidence leaf
stdin: ignored
stdout/stderr: piped
shell: false
detached: false
windowsHide: true
environment: exact frozen minimal map
~~~

The launcher validates application-argv cardinality, base64 canonicality, decoded byte/header
identity, source hash, 18,000-byte source ceiling, 24,576-character argument ceiling, and exact
Win32 serialized child command line at or below 30,000 UTF-16 code units before spawn. The adapter
child imports only the verified by-value data URL through B3. No Node load opens the live or
frozen adapter pathname.

The launcher retains the exact ChildProcess object and Node-owned handle until close, writes every
observed adapter stdout/stderr chunk directly to create-new raw sinks, enforces 16-MiB caps, and
records PID, handle-binding kind, argv/environment/cwd, spawn/error/exit/close event order,
exitCode, signalCode, wall/monotonic start/end, timeout/kill/reap, and drain facts. This is the
durable outer observation that V2 lacked.

## 27. Four-source boundary and nested evidence ownership

The future source review must prove these exact allowed static built-ins:

| Source | Allowed static built-ins |
| --- | --- |
| launcher | node:buffer, node:child_process, node:crypto, node:fs, node:path, node:stream, node:util |
| adapter | node:buffer, node:child_process, node:crypto, node:fs, node:path, node:stream, node:util |
| recorder | node:buffer, node:crypto, node:fs, node:path, node:url, node:worker_threads |
| predicate | node:buffer, node:crypto, node:worker_threads |

Launcher and adapter each call spawn exactly once with shell false: launcher launches only the
by-value adapter under B3; adapter launches only the by-value read-back frozen recorder under R3.
Recorder launches only the by-value read-back frozen predicate as one Worker data URL. No other
child, Worker, executable, or code load is allowed.

All four reviewed sources forbid import(), eval, Function, node:vm, createRequire, require,
process.dlopen, native addons, FFI, WebAssembly execution, package/relative/absolute/file imports,
network built-ins, fetch, shells, environment-selected code, and execution of repository data.
The only exceptions are B3's verified adapter data URL, R3's verified recorder data URL, and the
recorder's verified predicate Worker data URL. The launcher's ordinary path load by Node is not
called safe-by-value; it is the explicit outer TCB above.

The launcher exclusively creates the V3 leaf and all three registered directories. It opens the
root receipt.json and adapter raw sinks create-new before adapter spawn. The adapter is the sole
writer of regular files beneath adapter/; the launcher may only read that subtree after the child
closes. Recorder and predicate write no file. Ownership overlap is forbidden.

The adapter preserves V2's exact thirteen-input, vendor, metadata/resolver, toolchain,
same-validator, config/stale-lock, inert/no-op, callback, and live pre/post controls, plus the V3
historical-prefix positive/mutant control. Its first-party census includes all four live sources,
this complete V3 record, and the V3 source-freeze authority as external governance rows. Root
freezes every relevant lane during the one run.

After recorder completion, the adapter closes adapter/artifact-manifest.tsv and
adapter/receipt.json, then emits exactly one strict UTF-8/LF JSON value naming and hashing that
inner receipt; deliberate adapter stderr is empty. The launcher validates those actually observed
adapter-child bytes and observed exit, independently rehashes the closed inner subtree, writes the
root manifest and receipt, and folds the outer and inner statuses. Recorder self-report cannot
supply adapter lifecycle facts, and adapter self-report cannot supply its own observed outer
exit/streams.

## 28. Exact nested artifacts, receipts, and deadlines

### 28.1 Full certifiable topology

The full certifiable V3 leaf contains exactly 41 regular files and three directories:

~~~text
D	adapter/
D	adapter/frozen/
D	frozen/
F	adapter-bootstrap.mjs
F	adapter-child.argv.json
F	adapter-child.observation.json
F	adapter-child.stderr.bin
F	adapter-child.stdout.bin
F	adapter-envelope.b64
F	adapter/adapter-invocation.json
F	adapter/artifact-manifest.tsv
F	adapter/executor.after.json
F	adapter/executor.before.json
F	adapter/first-party.after.tsv
F	adapter/first-party.before.tsv
F	adapter/frozen/predicate.mjs
F	adapter/frozen/recorder.mjs
F	adapter/inputs.after.tsv
F	adapter/inputs.before.tsv
F	adapter/metadata.stderr.bin
F	adapter/metadata.stdout.json
F	adapter/predicate.stderr.bin
F	adapter/predicate.stdout.bin
F	adapter/receipt.json
F	adapter/recorder-bootstrap.mjs
F	adapter/recorder-child.argv.json
F	adapter/recorder-child.observation.json
F	adapter/recorder-child.stderr.bin
F	adapter/recorder-child.stdout.bin
F	adapter/recorder-envelope.b64
F	adapter/request.json
F	adapter/result.json
F	adapter/toolchain.after.tsv
F	adapter/toolchain.before.tsv
F	adapter/vendor.after.tsv
F	adapter/vendor.before.tsv
F	artifact-manifest.tsv
F	frozen/adapter.mjs
F	frozen/launcher.mjs
F	launcher-invocation.json
F	receipt.json
F	shell-command.ps1
F	shell-tcb.json
F	source-freeze.tsv
~~~

That list is already ordinal. Its exact UTF-8 serialization is type, TAB, forward-slash path, LF
for each row: 44 rows / 1,194 bytes / SHA-256
108ad06c2c1e9095def8b2caaa55c9aa6bb40364a22f97234a908ac1a3985ae6.

The adapter manifest hashes its 25 earlier inner regular files and excludes only
adapter/artifact-manifest.tsv and adapter/receipt.json. After the adapter exits and every inner
file is closed, the launcher root manifest hashes 39 earlier regular files, including the closed
inner manifest and receipt, and excludes only root artifact-manifest.tsv and root receipt.json.
Neither manifest lists directories. The inner receipt binds the inner manifest; the root receipt
binds the root manifest and the independently rehashed inner receipt. No file hashes itself and
there is no receipt/manifest cycle.

The launcher writes shell-command.ps1 as exact S3, shell-tcb.json with observed PowerShell/Node/
launcher path identities and residual-boundary flags, launcher-invocation.json with its observed
argv/execArgv/cwd/environment, source-freeze.tsv with S3/B3/R3 and four-source registered/observed
tuples, frozen/launcher.mjs as a nonattesting live-path copy, frozen/adapter.mjs from the one
verified adapter read, the adapter envelope/bootstrap/argv, actual adapter-child raw streams and
observation, then the root manifest and receipt.

The adapter owns every adapter/ file. Those files have the same meanings as the V2 inner
recorder/predicate artifacts, updated for R3, four source rows, the corrected historical-prefix
control, and the V3 authority record. The adapter's stdout is one strict UTF-8/LF summary of its
closed receipt; its stderr is deliberately empty. The launcher raw files are the actual pipe
bytes, not copies authored by the adapter.

### 28.2 Controlled failures

The launcher exclusively acquires the V3 leaf with one nonrecursive create-new directory
operation, creates all three registered directories, opens root receipt.json and both adapter raw
sinks create-new, and retains those handles before reading or spawning the adapter. From leaf
acquisition onward, every caught launcher/adapter launch, timeout, stream, parse, identity, or
inner-receipt failure produces a durable root receipt and manifest of the actual retained files.
It can never fold PASS/FAIL unless the exact 44-entry full topology is present.

If the adapter never creates a complete inner subtree, the root receipt names the missing entries,
retains zero-length or partial raw streams, and folds ERROR or STRUCTURAL. It does not fabricate
inner files. A shell or launcher-path failure before leaf acquisition creates no evidence run; a
launcher crash or root hard stop may leave a partial leaf, which is retained, uncertifiable, and
never reused. A pre-existing leaf is never touched.

### 28.3 Absolute monotonic deadlines

| Boundary | Exact limit/action |
| --- | --- |
| predicate Worker | 20,000 ms from Worker start |
| Worker termination/reap | 3,000 ms after deadline/fault |
| Worker stream drain | 2,000 ms after Worker terminal |
| recorder child | 35,000 ms from adapter spawn return |
| recorder terminate/reap | 3,000 ms graceful plus 2,000 ms forced |
| recorder pipe drain/destruction | 3,000 ms after close/final kill |
| adapter inner finalization | 60,000 ms from adapter/ acquisition |
| adapter child observed by launcher | 70,000 ms from launcher spawn return |
| adapter terminate/reap | 3,000 ms graceful plus 2,000 ms forced |
| adapter pipe drain/destruction | 3,000 ms after close/final kill |
| launcher root finalization | 85,000 ms from V3 leaf acquisition |
| root PowerShell hard stop | 100,000 ms from shell spawn, then kill and 5,000 ms bounded reap |

Every timeout is absolute and is not reset by progress. Launcher and adapter retain their exact
ChildProcess objects rather than reacquiring by PID. Timeout, cap, failed kill/reap, incomplete
drain, unresolved close, or root hard stop is ERROR and cannot produce a certified FAIL/PASS. Root
owns only the PowerShell process handle; PowerShell/Node descendants are not in a certified Job or
process group. V3 makes no zero-survivor claim if the outer TCB fails.

## 29. Nested status fold and claim boundary

The adapter first folds the recorder/predicate result by maximum severity on
PASS / 0 < FAIL / 1 < ERROR / 2 < STRUCTURAL / 3. The launcher independently folds the adapter's
actual streams/lifecycle/exit, inner artifact verification, outer topology, source/TCB pre/post
checks, and inner status on the same order. STRUCTURAL outranks concurrent ERROR; a valid measured
red remains FAIL and is never demoted.

- STRUCTURAL / 3 includes source/bootstrap/authority drift; false historical-prefix acceptance;
  high-bit/header-control failure; invalid schema/provenance/topology/manifest/receipt; observed
  child exit versus self-report mismatch; no-mutation/canonical/callback control failure; or any
  missing authoritative prerequisite.
- ERROR / 2 includes runtime/I/O exception after valid prerequisites; timeout/cap; failed
  kill/reap/drain; abnormal terminal event; or inability to complete a valid measurement.
- FAIL / 1 is reserved for a complete structurally valid measurement in which a real registered
  config/stale-lock inverse is accepted, launch-permitted, reaches its callback, or reports the
  wrong exact identity/mismatch.
- PASS / 0 requires the complete 44-entry topology, both observed process envelopes, all
  pre/post censuses, corrected historical provenance, bootstrap/canonical/inert controls, the live
  callback 0 to 1, both real inverse callbacks 0 to 0, and nothing unscored.

The launcher sets its intended exit only after the root receipt closes. PowerShell returns only
LASTEXITCODE, and root's observed shell exit is a same-session cross-check required before freeze.
That transient value is not post-reset evidence. The durable claim begins at the reviewed launcher
TCB and covers its actually observed adapter child, then the adapter's actually observed recorder
child. It does not prove which launcher bytes the OS opened.

Even after a future PASS plus physical-review GO, V3 would not establish a direct root-to-adapter
launch, path-open immutability, hostile same-account resistance, standalone attestation, dependency
safety, licensing, a fresh Cargo resolver/compiler run, build/test/product behavior, containment,
zero survivors, Q-152 behavior, Linux/macOS behavior, release readiness, or Rust-tool
certification. The narrow claim is only the exact source-only inverse result and durable nested
observation under the explicitly named outer TCB.

## 30. V3 release and independent review order

1. Freeze V3 while proving the first 63,359 bytes still hash to the V2 tuple. Root assigns fresh
   independent reviewers for historical provenance/bootstrap byte strictness and for the
   shell/launcher/nested-evidence topology. The author does not self-approve; conditional GO is
   NO-GO.
2. Only after both record GOs may root release separate authoring of the four exact sources. This
   V3 record grants no source creation. Predicate, recorder, adapter, then launcher source hashes
   are frozen in dependency order.
3. The V3 source-freeze authority must retain the full four-source tuples; exact S3/B3/R3 bytes and
   hashes; fixed high-bit fixtures/results; PowerShell/Node identities; shell selection/options;
   full adapter/recorder argv and Win32 serializations; minimal child environments; 44-entry
   topology; and all expected control/result schemas. Fresh source-security and lifecycle reviews
   must return unconditional GO.
4. Root rehashes V3/source-freeze/four sources, all thirteen inputs, corrected subject prefix/full
   subject, metadata/vendor/toolchain/first-party boundaries, and exact shell/Node executables;
   freezes all Rust lanes; verifies every V1/V2/V3 leaf is absent; and releases exact S3 once.
5. Root observes the shell under the 100-second deadline, checks its exit against the closed root
   receipt, and freezes every complete or failed artifact without rerunning the leaf.
6. A fresh physical reviewer who was neither record reviewer, author/source reviewer, nor executor
   reconstructs both child envelopes, B3/R3/S3, topology/manifests/receipts, corrected provenance,
   all mutants and status folds from physical bytes, then returns unconditional GO or NO-GO
   without execution or edit.

The supply-chain/Cargo gate remains **NO-GO** until every step above is complete and the physical
review is unconditional GO. Only root may then release a separately preregistered Cargo/build/test
tranche. Rust-tool documentation remains deferred until the relevant behavior is certified. This
append grants no execution, source creation, Cargo/rustc/rustup, build, test, product, browser,
network, evidence-leaf, or Git authority.

## 31. Exact V3 derived sentries

The exact derived V3 identities are:

| Object | Bytes / lines | SHA-256 |
| --- | --- | --- |
| B3, no terminal LF | 3,516 bytes / 84 LF / zero CR | 33fb6a28cf072aafb28a57dc23ad3d6992c2938c304790414033639615116558 |
| R3, no terminal LF | 3,520 bytes / 84 LF / zero CR | c75061148caf51d515f035520ee328e73b8ad93cbe6ba9bf5dd41a1fa87cd203 |
| S3, no terminal LF | 675 bytes / 17 LF / zero CR | 1ce3d3ba32ba6089aaca90419b2f7eb858e8ba3b0b40556274e3acaa7338d793 |
| full allowed-name serialization | 1,194 bytes / 44 LF / zero CR | 108ad06c2c1e9095def8b2caaa55c9aa6bb40364a22f97234a908ac1a3985ae6 |

The immutable V2 prefix sentry is 63,359 bytes /
be2f2ea6799499a87f2ace7801507470e2e84f6283132f6da4a464ea35ae5ec8. The corrected historical
prefix sentry is 184,665 bytes /
49d84f2b35f27c063c8c69dceae91ad29ba41162216cc9efa2ffe7f8ed449486. The full frozen subject
sentry remains 195,674 bytes /
f7157f11b7e63e2228cf851b3b6edec30168817c9291eee2f1ac9c27201bbcb2.

## 32. Append-only V4 recorder-transport and lifecycle repair authority

Sections 1 through 31 are the immutable V3 prefix: exactly 91,574 bytes / SHA-256
559c23cf5ec4873dd8c673da7941971cab9d8a1c4683471c4568b81c31a5d780. V4 changes no
prior byte, creates no source or evidence path, and authorizes no execution. The exact current
source-only inputs to this amendment are:

| Source | Bytes | SHA-256 | Text form |
| --- | ---: | --- | --- |
| predicate | 17,955 | dda9600272a3644f01fcc84cf845764ed7cb0f302574cd4abed8f0c471642428 | 174 LF, zero CR, no BOM, terminal LF |
| rejected recorder candidate | 17,993 | e9117e0889e5ec45054a36e329b2bc5051bdf3d9a25ff2b6759c6a3b173576de | 35 LF, zero CR, no BOM, terminal LF |

The predicate received prior static source/security GO/GO. V4 preserves those exact predicate
bytes; it does not convert source review into execution evidence.

Eärendil's recorder review, independently supported by Balin and Dwalin, returned terminal
NO-GO. The rejected recorder did not validate the full request, provenance, census, metadata,
toolchain, or nested predicate schemas; trusted selected predicate status instead of independently
folding the complete primitive result and reasons; used truthy tests where exact false, null, zero,
or empty distinctions are required; settled a stream error before close; permitted terminate-promise
continuations to mutate lifecycle state after snapshot; and left its result cap and stdout failure
outside a complete controlled fold. Positive stable-read, exact predicate source, primitive Worker
message, and active-outer-catch observations do not discharge those blockers.

Boromir's repair feasibility pass, independently checked by Bombur and Dori, found no source
candidate. A lifecycle/full-request draft reached 22,990 bytes before the approximately 3.1 KiB
nested primitive fold. Safe compaction recovered only approximately 2.5 to 3.5 KiB; the complete
recorder floor remained 22,590 to 23,590 bytes. Every temporary hunk was removed and the rejected
17,993-byte recorder tuple above remained unchanged.

Gandalf's transport analysis, with Pippin and Treebeard, proved that merely raising a source cap
does not make the R3 by-value argv transport feasible. For a recorder source of n bytes, the R3
envelope is n + decimalDigits(n) + 100 bytes and canonical base64 is four times the ceiling of that
value divided by three. The measured cases are:

| Recorder source | R3 envelope | Base64 argument | Full Win32 serialized invocation |
| ---: | ---: | ---: | ---: |
| 17,993 | 18,098 | 24,132 | 27,826 UTF-16 units |
| 22,590 | 22,695 | 30,260 | 33,954 UTF-16 units |
| 23,590 | 23,695 | 31,596 | 35,290 UTF-16 units |

The complete candidate range therefore exceeds the Win32 process-creation boundary before the
missing fold is added. A fifth source adds a new code-loading boundary without solving that fact;
compression adds decompressor, bomb, and canonicalization obligations. Neither is adopted.

Root adjudicates the smallest reversible repair: supersede only the recorder's R3 by-value argv
delivery with one EOF-sealed raw stdin frame and raise only the recorder source ceiling to 32,768
bytes. Preserve the four-source topology, exact predicate, S3, B3, and B3's 18,000-byte adapter
source cap. The pipe is a narrow transport boundary, not an authority or prompt channel. All bytes
inside it are untrusted data until R4 has observed EOF and validated the complete frame.

Halbarad's transport map used provisional 2026-08-30 V4 paths and the name
adapter/recorder-frame.bin. Those mapper-only names are superseded by this root adjudication. The
registered future paths are exactly:

~~~text
migration_doc/RUST_PROCESS_SUPERVISOR_SUPPLY_CHAIN_DURABLE_INVERSE_V4_SOURCE_FREEZE_2026-08-31.md
Tools/process-supervisor/output/supply-chain-durable-inverse-2026-08-31-v4/
adapter/recorder-envelope.bin
~~~

The source-freeze authority and evidence leaf are absent future paths. Their names grant no write
or run authority. V1 through V3 leaves remain untouched, absent, and unauthorized.

## 33. Exact EOF-sealed recorder frame

The adapter constructs one raw frame from the same stable, verified recorder buffer that it writes
and reads back as adapter/frozen/recorder.mjs. No second live or frozen pathname read may supply
frame bytes. The frame is exactly:

~~~text
ASCII CESIUM_SUPPLY_INVERSE_RECORDER_V4 followed by LF
ASCII canonical-decimal recorder-source byte length followed by LF
ASCII lowercase 64-hex SHA-256 of the recorder source followed by LF
exact recorder source bytes
EOF
~~~

The magic including LF is 34 bytes. Recorder source is 1 through 32,768 bytes, strict UTF-8, no
BOM, no CR, and terminal LF. Header size is 100 plus decimalDigits(sourceBytes); the maximum header
is 105 bytes and the maximum frame is exactly 32,873 bytes. The frame has no base64 layer and no
extra terminal byte. EOF is a required transport event and is not part of the frame hash.

The adapter performs exactly one recorder-child spawn with:

~~~text
executable: C:\Program Files\nodejs\node.exe
argv: --no-addons, --no-warnings, --input-type=module, --eval, exact R4
cwd: exact V4 adapter/ directory
environment: exact frozen minimal map
stdio: pipe, pipe, pipe
shell: false
detached: false
windowsHide: true
windowsVerbatimArguments: false
~~~

There is no application envelope argument. The successful child observes process.argv exactly
[process.execPath] and process.execArgv exactly the four fixed flags followed by exact R4. The
adapter owns the sole writable stdin endpoint and calls child.stdin.end(frame, callback) exactly
once; it performs no prior or later write or end. It records the frame bytes/SHA, the call and
callback result, stdin error, finish, close, and whether the endpoint settled before child
adjudication. A second write/end, inherited or ignored stdin, a buffer from another read, or an
unsettled/erroring writer makes the run ERROR and ineligible for PASS/FAIL.

The stdin endpoint is an anonymous byte-stream pipe. R4 never treats an empty chunk, zero available
bytes, or close as EOF. Only the readable end event is EOF. A complete frame whose writer remains
open reaches the fixed ingress deadline and imports nothing.

## 34. Exact R4 bootstrap bytes

R4 is exactly the UTF-8 text inside the following fence, excluding the fences, joined with LF,
with zero CR, no BOM, and no terminal LF:

~~~js
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
const MAGIC = Buffer.from("CESIUM_SUPPLY_INVERSE_RECORDER_V4\n", "ascii");
const SOURCE_MAX = 32768;
const FRAME_MAX = 32873;
const START = process.hrtime.bigint();
const DEADLINE = START + 5000000000n;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fault = (status, code) => Object.assign(new Error(code), { status, code });
const structural = (code) => fault(3, code);
const runtime = (code) => fault(2, code);
const expired = () => process.hrtime.bigint() >= DEADLINE;
const requireTime = () => { if (expired()) throw runtime("INGRESS_TIMEOUT"); };
const readFrame = () => new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  let settled = false;
  let timer;
  const remove = () => {
    clearTimeout(timer);
    process.stdin.off("data", onData);
    process.stdin.off("end", onEnd);
    process.stdin.off("error", onError);
    process.stdin.off("aborted", onAborted);
    process.stdin.off("close", onClose);
  };
  const finish = (handler, value, destroy = false) => {
    if (settled) return;
    settled = true;
    try {
      remove();
      if (destroy) process.stdin.destroy();
    } catch {
      reject(runtime("STDIN_CLEANUP"));
      return;
    }
    handler(value);
  };
  const timely = () => {
    if (!expired()) return true;
    finish(reject, runtime("INGRESS_TIMEOUT"), true);
    return false;
  };
  const onData = (value) => {
    if (!timely()) return;
    if (!(value instanceof Uint8Array)) {
      finish(reject, runtime("STDIN_CHUNK_TYPE"), true);
      return;
    }
    const chunk = Buffer.from(value);
    if (chunk.length === 0) return;
    if (total + chunk.length > FRAME_MAX) {
      finish(reject, structural("FRAME_SIZE"), true);
      return;
    }
    chunks.push(chunk);
    total += chunk.length;
  };
  const onEnd = () => {
    if (!timely()) return;
    finish(resolve, Object.freeze({ frame: Buffer.concat(chunks, total), eofObserved: true }));
  };
  const onError = () => finish(reject, runtime("STDIN_ERROR"), true);
  const onAborted = () => finish(reject, runtime("STDIN_ABORTED"), true);
  const onClose = () => finish(reject, runtime("STDIN_CLOSE_BEFORE_EOF"));
  const onTimer = () => {
    const remaining = DEADLINE - process.hrtime.bigint();
    if (remaining <= 0n) {
      finish(reject, runtime("INGRESS_TIMEOUT"), true);
      return;
    }
    timer = setTimeout(onTimer, Number((remaining + 999999n) / 1000000n));
  };
  process.stdin.on("data", onData);
  process.stdin.once("end", onEnd);
  process.stdin.once("error", onError);
  process.stdin.once("aborted", onAborted);
  process.stdin.once("close", onClose);
  const remaining = DEADLINE - process.hrtime.bigint();
  timer = setTimeout(onTimer, Number(remaining > 0n ? (remaining + 999999n) / 1000000n : 0n));
  process.stdin.resume();
});
const validate = ({ frame, eofObserved }) => {
  requireTime();
  if (!eofObserved) throw structural("EOF_REQUIRED");
  if (frame.length > FRAME_MAX) throw structural("FRAME_SIZE");
  if (!frame.subarray(0, MAGIC.length).equals(MAGIC)) throw structural("MAGIC");
  const lengthEnd = frame.indexOf(0x0a, MAGIC.length);
  const hashEnd = lengthEnd < 0 ? -1 : frame.indexOf(0x0a, lengthEnd + 1);
  if (lengthEnd < 0 || hashEnd < 0) throw structural("HEADER");
  const lengthBytes = frame.subarray(MAGIC.length, lengthEnd);
  if (lengthBytes.length === 0) throw structural("LENGTH_EMPTY");
  if (lengthBytes.length > 1 && lengthBytes[0] === 0x30) throw structural("LENGTH_LEADING_ZERO");
  let sourceBytes = 0;
  for (const value of lengthBytes) {
    if (value < 0x30 || value > 0x39) throw structural("LENGTH_BYTE");
    sourceBytes = sourceBytes * 10 + value - 0x30;
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes > SOURCE_MAX) throw structural("BYTE_LENGTH");
  }
  if (sourceBytes < 1) throw structural("BYTE_LENGTH");
  const hashBytes = frame.subarray(lengthEnd + 1, hashEnd);
  if (hashBytes.length !== 64) throw structural("HASH_LENGTH");
  for (const value of hashBytes) {
    const digit = value >= 0x30 && value <= 0x39;
    const lowerHex = value >= 0x61 && value <= 0x66;
    if (!digit && !lowerHex) throw structural("HASH_BYTE");
  }
  const expectedBytes = hashEnd + 1 + sourceBytes;
  if (frame.length < expectedBytes) throw structural("SOURCE_LENGTH");
  if (frame.length > expectedBytes) throw structural("TRAILING_DATA");
  const source = frame.subarray(hashEnd + 1);
  if (source.length >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf) throw structural("BOM");
  if (source.includes(0x0d)) throw structural("CR");
  if (source[source.length - 1] !== 0x0a) throw structural("TERMINAL_LF");
  try { new TextDecoder("utf-8", { fatal: true }).decode(source); } catch { throw structural("UTF8"); }
  const sourceSha256 = hashBytes.toString("ascii");
  if (sha256(source) !== sourceSha256) throw structural("HASH");
  const header = frame.subarray(0, hashEnd + 1);
  const rebuilt = Buffer.concat([MAGIC, Buffer.from(String(sourceBytes), "ascii"), Buffer.of(0x0a), Buffer.from(sourceSha256, "ascii"), Buffer.of(0x0a), source]);
  if (!rebuilt.equals(frame)) throw structural("HEADER_RESERIALIZE");
  requireTime();
  return Object.freeze({ eofObserved: true, frameBytes: frame.length, frameSha256: sha256(frame), headerBytes: header.length, headerSha256: sha256(header), sourceBase64: source.toString("base64"), sourceBytes, sourceSha256 });
};
let reported = false;
const report = async (status, code) => {
  if (reported) return;
  reported = true;
  process.exitCode = status;
  const kind = status === 3 ? "STRUCTURAL" : "ERROR";
  try {
    await new Promise((resolve, reject) => {
      try {
        process.stderr.write(`CESIUM_RECORDER_BOOTSTRAP_${kind}:${code}\n`, (error) => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
  } catch {
    process.exitCode = 2;
  }
};
try {
  if (process.argv.length !== 1 || process.argv[0] !== process.execPath) throw structural("ARGV");
  if (process.execArgv.length !== 5 || JSON.stringify(process.execArgv.slice(0, 4)) !== JSON.stringify(["--no-addons", "--no-warnings", "--input-type=module", "--eval"])) throw structural("EXECARGV");
  if (process.stdin.isTTY === true || process.stdin.readable !== true) throw structural("STDIN_TOPOLOGY");
  const capsule = validate(await readFrame());
  Object.defineProperty(globalThis, "__CESIUM_SUPPLY_INVERSE_RECORDER_V4__", { value: capsule, writable: false, configurable: false, enumerable: false });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__CESIUM_SUPPLY_INVERSE_RECORDER_V4__");
  if (!descriptor || descriptor.writable || descriptor.configurable || descriptor.enumerable || descriptor.value !== capsule) throw structural("CAPSULE");
  try { await import("data:text/javascript;base64," + capsule.sourceBase64); }
  catch { await report(2, "IMPORT"); }
} catch (error) {
  const known = error && (error.status === 2 || error.status === 3) && typeof error.code === "string";
  await report(known ? error.status : 2, known ? error.code : "BOOTSTRAP_RUNTIME");
}
~~~

The exact R4 source sentry is recorded in section 42 from this fence. R4 statically imports only
node:buffer, node:crypto, and node:util. It introduces no fifth reviewed source. Its sole dynamic
import is the data URL of the exact frame-validated recorder bytes after EOF.

R4 samples one monotonic absolute deadline immediately after its imports/constants. The deadline is
5,000 ms and is never reset by progress. Every chunk and EOF is rejected when observed at or after
that deadline. Retained frame bytes never exceed 32,873. Header bytes are checked as exact ASCII
before conversion; decimal is nonzero and has no leading zero; hash is exactly 64 lowercase hex;
source length, strict text shape, hash, no trailing byte, and whole-frame byte reserialization must
all agree before capsule construction.

Malformed magic/header/decimal/hash/source, cap, length mismatch, trailing bytes, text-shape defect,
or failed reserialization is STRUCTURAL/3. Ingress timeout, stdin type/I/O/abort/close-before-EOF,
unexpected bootstrap runtime, cleanup/publication failure, or validated recorder import/evaluation
failure is ERROR/2. Before recorder import stdout is empty. At most one fixed ASCII/LF stderr line
is emitted: CESIUM_RECORDER_BOOTSTRAP_STRUCTURAL:<registered-code> or
CESIUM_RECORDER_BOOTSTRAP_ERROR:<registered-code>. Raw input and exception text are never emitted.

The adapter validates that exact line, empty stdout, and observed child exit independently. Missing,
partial, multiple, unknown, or exit-disagreeing output cannot support PASS/FAIL. A pre-recorder
failure fabricates no result.json, predicate stream, or recorder result; the adapter retains only
bytes it actually held or observed and names every missing topology entry in its own receipt.

## 35. R4 capsule and recorder entry contract

The successful capsule is frozen, installed once under
__CESIUM_SUPPLY_INVERSE_RECORDER_V4__, and has exact insertion-order keys:

~~~text
eofObserved, frameBytes, frameSha256, headerBytes, headerSha256,
sourceBase64, sourceBytes, sourceSha256
~~~

Its property descriptor is nonwritable, nonconfigurable, and nonenumerable. The future recorder
must, before reading request.json, frozen/predicate.mjs, or starting a Worker:

1. require the one-argument process.argv form containing only process.execPath;
2. require exact process.execArgv including the registered R4 bytes;
3. require the registered cwd, environment, Node path/version/platform/arch, and no denied startup
   variable;
4. require the sole exact capsule descriptor and exact ordered key set;
5. canonically decode sourceBase64 and prove all source/header/frame byte and SHA fields, strict
   source text, source registration, and eofObserved === true; and
6. reject any pathname code load, second capsule, R3 argv fallback, or request/file/Worker action
   before those predicates complete.

R3 remains historical provenance only. B3 and S3 remain byte-identical to section 31.

## 36. Complete canonical request schema

The V4 adapter writes request.json before recorder spawn as one strict UTF-8/LF, no-BOM, canonical
JSON value. Duplicate keys cannot survive byte-for-byte canonical reserialization. Its exact
top-level insertion-order keys are:

~~~text
authority, bootstraps, censuses, claimLimits, cwd, deadlines, environment,
evidence, inputs, limits, metadata, nonce, predicate, protocol, recorder,
registrations, runtime, schema, sources, toolchain, topology, vendor, version
~~~

Every object below has exactly the named keys in the named order; every future source-freeze value
instantiates these shapes without adding a field:

- authority: v1Prefix, v2Prefix, v3Prefix, v4, sourceFreeze. Each prefix has bytes and sha256;
  v4 and sourceFreeze have path, bytes, and sha256.
- bootstraps: s3, b3, r4. Each has bytes, lf, cr, bom, terminalLf, sha256, and sourceBase64; the
  sourceBase64 value decodes canonically to the exact registered bytes.
- censuses: grammar, inputs, vendor, firstParty, toolchain. grammar has pathForm, recordForm,
  ordinal, terminalLf, symlinkPolicy, and exclusions. Each other value has beforePath, afterPath,
  expectedRows, expectedBytes, and expectedSha256; a value not fixed before execution is the exact
  null literal, never omitted or guessed.
- evidence: leaf, allowedNamesBytes, allowedNamesSha256, allowedEntries, regularFiles,
  directories, adapterManifestRows, rootManifestRows, receiptRule, and createRule.
- inputs: canonicalBase64, configBase64, historicalPrefixBase64, lockBase64, and registrations.
  registrations is the exact ordered thirteen-row array of path, bytes, and sha256 objects.
- limits: predicateResultBytes, recorderResultBytes, requestBytes, workerStdoutBytes,
  workerStderrBytes, recorderSourceBytes, recorderFrameBytes, adapterSourceBytes,
  adapterEnvelopeChars, and childCommandLineUnits.
- metadata: stdoutPath, stdoutBytes, stdoutSha256, stderrPath, stderrBytes, stderrSha256,
  packages, registryPackages, workspaceMembers, registrySetSha256, and resolverRule.
- predicate and recorder: path, bytes, sha256, text, allowedImports, forbiddenLoads, and schema.
- protocol: requestSchema, recorderResultSchema, predicateResultSchema, messageEnvelopeSchema,
  reasonOrder, statusOrder, and exitMap.
- registrations: canonicalControls, configInverse, staleLockInverse, historicalPrefix,
  historicalFalseClaim, callbackControls, and routingControls.
- runtime: execPath, execBytes, execSha256, version, platform, arch, cwd, argv, execArgv,
  environmentSha256, stdinKind, stdinWrites, and stdinEofRequired.
- sources: launcher, adapter, recorder, predicate. Each has path, bytes, sha256, lf, cr, bom,
  terminalLf, and allowedImports.
- toolchain: node, cargo, rustc. Each has path, bytes, sha256, and version.
- topology: orderedEntries, serializationBytes, serializationSha256, adapterManifestRows,
  rootManifestRows, and noncircularRule.
- vendor: root, files, bytes, canonicalSha256, embeddedManifestBytes,
  embeddedManifestSha256, registryDirectories, and registrySetSha256.

claimLimits is the exact registered ordered string array; deadlines has workerMs,
terminateReapMs, drainMs, ingressMs, recorderChildMs, recorderReapMs, recorderDrainMs,
adapterMs, adapterChildMs, adapterReapMs, adapterDrainMs, launcherMs, rootMs, and rootReapMs;
environment is the exact ordinal minimal string map; nonce is the registered bounded nonce;
cwd, schema, and version are exact literals.

Validation is recursive and exhaustive. Unknown, missing, repeated, reordered, or differently typed
keys are STRUCTURAL. Booleans are accepted only by === true or === false; required nulls only by
=== null; integers are safe integers within their registered bounds; hashes are lowercase 64-hex;
arrays have exact order/cardinality; enum strings are exact. Empty string, zero, one, null, and
missing never pass via truthiness. The future source-freeze must print the fully instantiated
canonical request bytes/SHA and every recursive schema table; absence of that material is NO-GO.

## 37. Complete predicate-result schema and independent fold

The current predicate result is accepted only after recursive validation of these exact key sets:

| Object | Exact insertion-order keys |
| --- | --- |
| top | schema, nonce, validatorId, status, exit, reasons, controls, inverses |
| controls | runtime, malformedRouting, liveSyntax, malformed, liveRun, inert, bypass, overfire, directRoute, wrongNonce, historicalPositive, historicalFalseClaim, substitution |
| runtime | expected, observed, accepted, reason |
| validator reject | validatorId, bytes, sha256, accepted, reason, rowCount |
| validator accept | validatorId, bytes, sha256, accepted, reason, rowCount, rows |
| canonical row | path, bytes, sha256 |
| malformed | order, separator, terminal |
| routing | routeId, checkerId, currentNominal, bypassCount, bypassIdentities, accepted, rejected, reason |
| bypass identity | name, bytes, sha256 |
| gate run | gate, callbackBefore, callbackAfter, callbackNonces |
| identity gate | syntax, accepted, launchPermitted, mismatches |
| nonvacuity | accepted, changedBytes, mutantBytes, mutantSha256, tupleBytes, tupleSha256 |
| canary | accepted, reason |
| historical | accepted, bytes, changedSubjectBytes, observedSha256, expectedSha256, reason |
| inverses | config, staleLock |
| inverse | nonvacuity, run |
| Worker message | jsonBase64, jsonSha256 |

Complete PASS/FAIL measurements require nonnull controls and inverses with every nested object
above. A controlled predicate exception requires controls === null and inverses === null, exactly
one bounded reason, and the same top-level keys. The closed structural exception-reason allowlist
is PARENT_PORT_ABSENT, WORKER_DATA_SCHEMA, WORKER_DATA_KEYS, WORKER_DATA_VERSION, NONCE_FORM,
CANONICAL_BASE64_FORM, CANONICAL_BASE64_SIZE, CANONICAL_BASE64_CANONICAL,
CONFIG_BASE64_FORM, CONFIG_BASE64_SIZE, CONFIG_BASE64_CANONICAL, LOCK_BASE64_FORM,
LOCK_BASE64_SIZE, LOCK_BASE64_CANONICAL, HISTORICAL_PREFIX_BASE64_FORM,
HISTORICAL_PREFIX_BASE64_SIZE, HISTORICAL_PREFIX_BASE64_CANONICAL,
CANONICAL_ROWS_ABSENT, CANONICAL_TAB_ABSENT, CURRENT_CANONICAL_UNAVAILABLE, and
STALE_LOCK_LITERAL_MISMATCH. Any other controlled-exception reason derives ERROR.

The recorder ignores the predicate-selected status, exit, and reasons while deriving authority.
For a complete measurement it recomputes structural reasons in this exact order:

~~~text
PROCESS_EXECARGV_CONTROL
CURRENT_CANONICAL
ORDER_CONTROL
SEPARATOR_CONTROL
TERMINAL_CONTROL
MALFORMED_ROUTING_CONTROL
CONFIG_LIVE_IDENTITY
CONFIG_TUPLE_SYNTAX
LOCK_LIVE_IDENTITY
LOCK_TUPLE_SYNTAX
LIVE_GATE
INERT_CONTROL
BYPASS_CONTROL
OVERFIRE_CONTROL
DIRECT_ROUTE_CONTROL
WRONG_NONCE_CONTROL
HISTORICAL_POSITIVE
HISTORICAL_FALSE_CLAIM
HISTORICAL_TUPLE
SUBSTITUTION_CONTROL
~~~

Each reason is derived from the complete exact primitive object, not the selected boolean alone.
The recorder separately derives config and stale-lock product reds from their registered source
and tuple identities, changed-byte/removed-byte counts, nonvacuity, canonical syntax, exact sole
mismatch, accepted/launchPermitted values, and callback 0 to 0 arrays. A complete valid inverse red
is FAIL. A self-control, schema, provenance, or selected-versus-derived disagreement is STRUCTURAL.
A runtime/lifecycle/cap/I/O inability to complete a valid measurement is ERROR. PASS requires every
primitive complete and green.

The recorder deduplicates derived reasons in the frozen order, derives status by maximum severity
PASS/0 < FAIL/1 < ERROR/2 < STRUCTURAL/3, derives exit from status, and only then compares all
three values with predicate status, exit, and reasons. Any mismatch adds a STRUCTURAL reason. The
outer recorder fold then combines that derived predicate state with request, protocol, Worker,
stream, and lifecycle primitives. A selected PASS can never override a failing primitive.

## 38. Recorder lifecycle state machine

The future recorder must implement this exact lifecycle order:

1. Attach Worker, message, stdout, and stderr handlers before waiting.
2. Wait for the first Worker exit, latched fault, or absolute 20,000 ms Worker deadline.
3. A stream error/cap, Worker error, message/protocol fault, or deadline latches cancellation once.
4. On cancellation, call Worker.terminate exactly once and destroy stdout and stderr exactly once
   before beginning reap wait.
5. Wait at most 3,000 ms for both the Worker exit event and, when requested, the terminate promise
   settlement. A resolved terminate promise is not an exit observation.
6. Set reapComplete true only after the physical Worker exit event.
7. After the reap window, wait at most 2,000 ms for both stream close events. Error records ERROR
   but never settles a stream before close. Healthy completeness requires end followed by close,
   with no error, cap, cancellation, truncation, or destruction.
8. At drain deadline destroy both streams if not already destroyed and retain ERROR.
9. Disable event acceptance, detach every listener, seal both captures, copy all values into plain
   immutable data, then freeze events and reasons before serialization.

Terminate-promise continuations resolve only a private deferred outcome. They never mutate report
variables, reasons, events, or snapshots. Late terminate, Worker, or stream events after event
acceptance closes cannot mutate canonical result bytes. Lifecycle output contains exact booleans
for terminate requested/resolved/rejected, terminal observed, reap complete, each stream destroy
requested, end/error/close observed, cap exceeded, complete, and drain complete. Event order proves
cancellation, terminate, reap adjudication, stream adjudication, then snapshot.

The recorder result and Worker message caps are part of the controlled fold. It constructs a full
bounded candidate, measures canonical bytes, and if over the 16 MiB recorder cap adds
RECORDER_RESULT_CAP and builds the registered small ERROR fallback. The fallback is remeasured and
must fit. The intended exit is set before the single stdout write. Synchronous write throw and
asynchronous callback failure are caught as ERROR without a second result write or unhandled
rejection. The adapter, not the recorder, proves actual stdout completeness and observed exit.

## 39. V4 evidence topology and ownership

The V3 maximum topology remains 41 regular files and three directories. Exactly one name changes:

~~~text
adapter/recorder-envelope.b64
adapter/recorder-envelope.bin
~~~

The bin file contains the exact raw R4 frame with no added or excluded byte. The ordinal 44-row
type/TAB/forward-path/LF serialization remains 1,194 bytes but its V4 SHA-256 is
07da97e8a6e3239818a88fda3d750db2e78310c6ed6d1fc8d0af3134e03fcb9d. The adapter manifest
still hashes its 25 earlier inner regular files and excludes only its manifest and receipt. The
root manifest still hashes 39 earlier regular files and excludes only its manifest and receipt.
No manifest lists directories and no file hashes itself.

recorder-child.argv.json records no recorder envelope argument. It records stdin as piped, exact
R4, exact frame bytes/hash/header/source identities, one-write/end lifecycle, child options, cwd,
environment, Win32 serialization, and observed child lifecycle. Pre-recorder failure retains only
actual outer artifacts and cannot fabricate missing inner files. PASS/FAIL requires the complete
44-entry topology; ERROR/STRUCTURAL retains and names any partial topology.

Launcher exclusively owns the V4 leaf/root receipt/root raw sinks and outer files. Adapter owns
adapter/ and its regular files. Recorder and predicate write no filesystem path. All create-new,
noncircular manifest/receipt, no-reuse, retained-red, and first-party/vendor/input/toolchain census
rules from V3 remain binding, with this V4 record and source-freeze as the external governance rows.

## 40. Required green controls and biting mutants

R4/frame controls include canonical minimum/current/32,768-byte sources; one chunk, one-byte
chunks, every two-chunk split, every header/source-boundary split, and empty interspersed chunks;
immediate EOF and just-before-deadline completion. Complete bytes held open must time out ERROR with
no capsule/import. The controls cover 32,873 accepted and 32,874 rejected frame size, wrong magic,
empty/zero/leading-zero/nondecimal/high-bit/overflow length, 32,769 source declaration, short/long/
uppercase/nonhex/high-bit hash, truncated header/source, trailing byte, concatenated second frame,
BOM, CR, invalid UTF-8, missing terminal LF, source hash mismatch, and failed reserialization.

Biting transport mutants release/import before EOF; treat empty data, zero availability, or close
as EOF; reset the deadline; accept a chunk/EOF at or after deadline; allocate from an untrusted
declaration; decode header as a string before byte validation; omit cap/hash/text/reserialization;
build from a second pathname read; diverge frozen recorder from frame source; restore argv payload;
use write plus end or multiple end calls; inherit/ignore stdin; construct a mutable/wrong/multiple
capsule; pathname-import or import twice; echo attacker bytes; or emit multiple/unknown lines.

Lifecycle controls cover error followed by delayed close on each stream; cancellation destroying
both streams; destroy-one-only mutant; cancel/terminate after reap-wait mutant; terminate throw,
reject, timeout, and late resolve; terminate resolve without Worker exit; Worker exit without both
stream closes; close before end; cap; Worker error; zero/two messages; nonzero exit; unexpected
stderr; stdout-summary mismatch; and late events after snapshot. The final canonical result hash
must remain unchanged after every late-event control.

Schema/fold controls delete and add a key at every request and nested-result boundary; reorder
keys/arrays; change cardinality; duplicate reasons; substitute 1, 0, empty string, null, or missing
for every boolean; omit each authority/source/source-freeze/vendor/metadata/resolver/toolchain/
census/topology/control block; select PASS/0/empty reasons over a red primitive; select FAIL over a
structural primitive; corrupt the reason list; cross every input/message/result cap at minus one,
exactly, and plus one; force bounded fallback; and force stdout synchronous/callback failure.
Every control proves its checker turns red; deletion-only mutation is insufficient where an inert
or bypassed path could remain green.

## 41. V4 freeze and release order

1. Freeze this append while proving the first 91,574 bytes retain the V3 hash.
2. Obtain two fresh unconditional record GOs: one for R4 frame/bootstrap/security/Win32 transport,
   and one for recorder lifecycle/full schemas/evidence/independent status fold. Conditional GO is
   NO-GO.
3. Only then may root separately authorize source work in dependency order: the exact predicate is
   rehashed unchanged, then recorder, adapter, and launcher are repaired and frozen. This record
   grants no source creation.
4. Create and freeze the exact 2026-08-31 V4 source-freeze authority with four source tuples,
   S3/B3/R4, frame fixtures, Win32 serializations, schemas, topology, caps, and controls.
5. Obtain fresh unconditional source-security and lifecycle/evidence GOs over that exact tuple.
6. Root terminally rehashes every authority/source/input/vendor/metadata/toolchain/census/executable
   boundary, freezes every Rust lane, proves V1 through V4 leaves absent, and only then may release
   exact S3 once under a separately explicit execution authorization.
7. Freeze every resulting artifact, including FAIL, ERROR, STRUCTURAL, partial, or malformed output;
   never rerun into the V4 leaf.
8. A fresh physical reviewer who was neither record reviewer, source author/reviewer, nor executor
   reconstructs S3/B3/R4, both child observations, Worker result, schemas, manifests, receipts,
   mutants, lifecycle, and independent folds from physical bytes and returns unconditional GO or
   NO-GO without execution or edit.

The supply-chain/Cargo gate remains categorically NO-GO through record review, source authoring,
source review, and the one-shot run. It can advance only after complete physical evidence receives
fresh unconditional independent GO. This append grants no source, Node, Cargo, rustc, rustup,
build, test, product, Q-152, browser, network, evidence, documentation, Git, commit, or push
authority.

## 42. Exact V4 derived sentries

The exact deterministic V4 sentries are:

| Object | Bytes / lines | SHA-256 |
| --- | --- | --- |
| R4, no terminal LF | 7,220 bytes / 155 LF / zero CR | bf7d864f92ed925cef1fedce30dd3cbc890af2ff2a5aae76d17908a725bab38d |
| V4 allowed-name serialization | 1,194 bytes / 44 LF / zero CR | 07da97e8a6e3239818a88fda3d750db2e78310c6ed6d1fc8d0af3134e03fcb9d |
| canonical 18-byte fixture header | 102 bytes | d4e4fad4513b34e2b26b0fb7cb7a068758685985418221b900071ee74560e860 |
| canonical 18-byte fixture frame | 120 bytes | 7b299dc512dab7e620de74d2c088bf5ed06def9ef0c20541184c93b7d0c10073 |
| length high-bit fixture frame | 120 bytes | ac1358c1ceb8218f14e8ed97e893529d81cdb1b3f9bffc949c59166a497a4158 |
| hash high-bit fixture frame | 120 bytes | 9b9885726f5124d64e5bd356ec8b3b28f3527737b67131134fce1b666fc69194 |
| trailing-zero fixture frame | 121 bytes | a9a659291689b1f6f6dbd9ad0ed0da0e2ad40174af99dad06177ce8f1554db0f |
| concatenated fixture frames | 240 bytes | 9a7c25910ded7547a3f34bf8ab805a9fcd0c30a3855cc9cb0378978894e023cb |

The inert fixture source remains exact ASCII export-default-zero-semicolon-LF: 18 bytes /
9a15b5aa00cb010b885ffae3d28ab390fe0f8a9df7f47f30fd719ace8ed203b1. The length high-bit
mutant changes only the first decimal byte 0x31 to 0xb1. The hash high-bit mutant changes only the
first hash byte 0x39 to 0xb9. The trailing mutant appends exactly one 0x00. The concatenated mutant
is two exact canonical fixture frames. Source-freeze must additionally record the exact R4 child
Win32 command string, its non-NUL unit count 7,442, and its NUL-inclusive count
7,443. The non-NUL count must be at most 30,000 and the NUL-inclusive count at most
32,767. The stdin frame contributes zero command-line units.

## 43. Append-only V5 schema, registration, and trust-sequencing authority

This V5 append preserves the complete 126,391-byte V4 record byte-for-byte. Its immutable prefix
is SHA-256 3b597ae14ad13ce2ac4fd3904b68428d6336c93cdc24cc687b08d6e4bb4a087a,
2,133 LF, zero CR, no BOM, and one terminal LF. The 34,817-byte V4 suffix remains SHA-256
a69afe73d23f358b364ecee351aab698f1e2a0b28bddcdd75db8bd4c29cd34ff. Every V1 through V4
failure, red, hold, and NO-GO remains valid. In particular, the V4 R4/bootstrap source and every
V4 R4, frame, Win32-command, and topology sentry are historical only and are ineligible for a V5
source or execution release.

Eomer's independent V4 review remains static-record NO-GO and release NO-GO. V5 repairs only the
record omissions it found: a recursively closed request grammar, exact recorder/message/result
and lifecycle protocols, a total reason fold, and a noncircular preregistration sequence. This
append is an author candidate, is not a review of itself, and cannot return GO. It requires two
fresh unconditional nonauthor reviews over its final physical tuple.

The exact V5 protocol names are:

| Object | Exact identifier |
| --- | --- |
| request | CESIUM_SUPPLY_INVERSE_RECORDER_REQUEST_V5 |
| recorder result | CESIUM_SUPPLY_INVERSE_RECORDER_RESULT_V5 |
| recorder cap fallback | CESIUM_SUPPLY_INVERSE_RECORDER_CAP_FALLBACK_V1 |
| predicate result | CESIUM_SUPPLY_INVERSE_PREDICATE_V3 |
| Worker message | CESIUM_SUPPLY_INVERSE_MESSAGE_V1 |
| recorder registration | CESIUM_SUPPLY_INVERSE_RECORDER_REGISTRATION_V5 |
| R4-V5 capsule | __CESIUM_SUPPLY_INVERSE_RECORDER_V5__ |
| recorder child observation | CESIUM_SUPPLY_INVERSE_RECORDER_CHILD_OBSERVATION_V5 |
| adapter child observation | CESIUM_SUPPLY_INVERSE_ADAPTER_CHILD_OBSERVATION_V5 |
| adapter summary | CESIUM_SUPPLY_INVERSE_ADAPTER_SUMMARY_V5 |

The future source-freeze path is exactly
migration_doc/RUST_PROCESS_SUPERVISOR_SUPPLY_CHAIN_DURABLE_INVERSE_V5_SOURCE_FREEZE_2026-08-31.md.
The one-shot evidence leaf is exactly
Tools/process-supervisor/output/supply-chain-durable-inverse-2026-08-31-v5/. No V1, V2, V3, or
V4 leaf may be created, reused, renamed, adopted, or supplemented.

## 44. One-way recorder registration and pre-request entry gate

V5 has this single acyclic trust order:

1. Retain and independently rehash the exact predicate V3 source, 17,955 bytes / SHA-256
   dda9600272a3644f01fcc84cf845764ed7cb0f302574cd4abed8f0c471642428.
2. Author and freeze the recorder V5 source. It embeds the predicate tuple, exact entry
   runtime/cwd/environment constants, canonical schemas, and the authoritative reason order and
   classification map below. It does not embed or pin R4-V5 and does not read request authority
   to establish its own identity.
3. Only after the recorder tuple is frozen, instantiate a new literal R4-V5 source. R4-V5 embeds
   the exact recorder byte count and lowercase SHA-256 as source literals; it contains no
   signature channel and performs no runtime templating. The V4 R4 is historical and cannot be
   substituted.
4. Freeze R4-V5, then author and freeze the adapter. The adapter embeds the exact R4-V5 bytes and
   SHA-256 and the same authoritative reason order/classification map as the recorder.
5. Freeze the launcher and then construct the two-phase V5 source-freeze in section 51. That
   external record crosschecks the predicate -> recorder -> R4-V5 -> adapter -> launcher chain.
   No covered source embeds the complete source-freeze hash.

R4-V5 accepts only exact process.execArgv
[--no-addons,--no-warnings,--input-type=module,--eval,<literal R4-V5 source>], exact one-element
process.argv [process.execPath], a single piped stdin, exactly one frame, and physical EOF before
import. It uses a frozen absolute ingress deadline of 5,000 ms. Its registered magic is exactly
CESIUM_SUPPLY_INVERSE_RECORDER_V5 followed by one LF. Header serialization remains
magic + decimal source byte count + LF + lowercase source SHA-256 + LF. The future source-freeze,
not this record, must recompute every R4-V5 source, header, frame, fixture, and Win32 child-command
sentry from the final frozen bytes; no V4-derived byte count or digest may be copied.

After strict frame validation R4-V5 installs exactly one nonwritable, nonconfigurable,
nonenumerable capsule. Its exact insertion-order keys are:

~~~text
eofObserved, frameBytes, frameSha256, headerBytes, headerSha256,
registrationSchema, registeredSourceBytes, registeredSourceSha256,
sourceBase64, sourceBytes, sourceSha256
~~~

registrationSchema is CESIUM_SUPPLY_INVERSE_RECORDER_REGISTRATION_V5. The registeredSource
values are R4-V5's literal recorder constants; the observed source/header/frame values are
independently derived from the one accepted stdin buffer. R4-V5 requires observed sourceBytes and
sourceSha256 to equal the registered literals before the data-URL import. All capsule values are
plain immutable primitives.

Before reading request.json, frozen/predicate.mjs, metadata, a census, or starting a Worker, the
recorder performs one side-effect-free entry gate. It requires:

1. exact process.argv [process.execPath];
2. the five-item process.execArgv shape above, strict UTF-8 R4-V5 text in item four, and an
   independently measured observed execArgv[4] tuple;
3. the frozen absolute Node executable tuple/version/platform/arch, cwd, and exact empty
   process.env map;
4. the sole capsule descriptor, exact capsule key order, exact registrationSchema, canonical
   Base64, registered/observed source equality, strict source text, rebuilt header/frame equality,
   physical EOF, and the registered recorder tuple; and
5. no pathname code load, request read, predicate read, Worker construction, or evidence write
   before every preceding predicate succeeds.

The recorder records the observed execArgv[4] bytes and SHA-256 but contains no expected R4-V5
hash. The later request's R4-V5 and recorder fields are duplicate claims only. They cannot make
entry valid. The adapter's literal R4-V5 identity and the source-freeze's independent chain
crosscheck provide the R4-V5 authority without a recorder/R4 mutual hash cycle.

The exact child environment is the empty ordinal map {}. Its canonical UTF-8 bytes are the two
bytes 0x7b 0x7d with no LF, and environmentSha256 is
44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a. Exact runtime, cwd, and
minimal-environment expectations are constants in recorder V5 and R4-V5 before recorder freeze;
request values are checked duplicates, never their authority.

## 45. Closed canonical-JSON grammar and complete request shape

The adapter writes request.json as exactly UTF-8(JSON.stringify(validatedValue)) followed by one
0x0a. The total cap is 1,048,576 bytes including that LF. The bytes must be nonempty strict UTF-8,
contain no BOM and no CR, end in exactly one LF, and contain no byte after it. Parsing the bytes
before that LF and reserializing with JSON.stringify must reproduce every byte before that LF.

Every object is a plain object with exactly the registered own enumerable data keys in registered
insertion order. Unknown, missing, duplicated, reordered, inherited, accessor, or symbol keys are
STRUCTURAL. Every array has exact registered order and cardinality. A JSON number is accepted only
when Number.isSafeInteger is true, it is nonnegative and in the registered range, and its
canonical serialization contains neither -0, a fraction, nor an alternate exponent spelling.
Booleans are accepted only by identity with true or false and null only by identity with null.
Hashes are lowercase 64-hex. Base64 is padded RFC 4648 Base64 whose decode/re-encode is identical.
The nonce matches [A-Za-z0-9_-]{16,128}. Missing, empty, zero, one, false, true, and null are never
interchanged by truthiness.

The exact request top-level insertion-order keys are:

~~~text
authority, bootstraps, censuses, claimLimits, cwd, deadlines, environment,
evidence, inputs, limits, metadata, nonce, predicate, protocol, recorder,
recorderRegistration, registrations, runtime, schema, sources, toolchain,
topology, vendor, version
~~~

The following reusable shapes are exact:

| Shape | Exact insertion-order keys and primitive rules |
| --- | --- |
| tuple | bytes, sha256; bytes is a positive safe integer and sha256 is lowercase 64-hex |
| pathTuple | path, bytes, sha256; path is an exact registered string |
| sourceTuple | path, bytes, sha256, lf, cr, bom, terminalLf, allowedImports |
| bootstrap | bytes, lf, cr, bom, terminalLf, sha256, sourceBase64 |
| census | beforePath, afterPath, expectedRows, expectedBytes, expectedSha256 |
| inputRegistration | path, bytes, sha256 |
| program | path, bytes, sha256, text, allowedImports, forbiddenLoads, schema |
| unavailable | not_attempted_due_to; value is one registered global reason code |

sourceTuple counts are nonnegative safe integers, bom and terminalLf are exact booleans, and
allowedImports is an exact string array. bootstrap sourceBase64 canonically decodes to exactly
bytes bytes and hashes to sha256. census expectedRows, expectedBytes, and expectedSha256 are
either their registered integer/hash or exact null. unavailable is used only for a causally
unstarted object and its code is not added again as a cascade reason.

The recursively closed request schema is:

| Top key | Exact value |
| --- | --- |
| authority | exact keys v1Prefix, v2Prefix, v3Prefix, v4Prefix, v5, sourceFreeze; prefixes are tuple, v5 and sourceFreeze are pathTuple |
| bootstraps | exact keys s3, b3, r4Historical, r4V5; each is bootstrap |
| censuses | exact keys grammar, inputs, vendor, firstParty, toolchain; the latter four are census |
| claimLimits | exact five-string array frozen below |
| cwd | exact absolute V5 adapter cwd string frozen below |
| deadlines | exact sixteen-key object frozen below |
| environment | exact empty plain object |
| evidence | exact keys leaf, allowedNamesBytes, allowedNamesSha256, allowedEntries, regularFiles, directories, adapterManifestRows, rootManifestRows, receiptRule, createRule |
| inputs | exact keys canonicalBase64, configBase64, historicalPrefixBase64, lockBase64, registrations |
| limits | exact sixteen-key object frozen below |
| metadata | exact keys stdoutPath, stdoutBytes, stdoutSha256, stderrPath, stderrBytes, stderrSha256, packages, registryPackages, workspaceMembers, registrySetSha256, resolverRule |
| nonce | registered nonce string |
| predicate | program |
| protocol | exact keys requestSchema, recorderResultSchema, recorderCapFallbackSchema, predicateResultSchema, messageEnvelopeSchema, reasonOrder, reasonClasses, statusOrder, exitMap |
| recorder | program |
| recorderRegistration | exact keys registrationSchema, sourceBytes, sourceSha256, r4ObservedBytes, r4ObservedSha256 |
| registrations | exact keys canonicalControls, configInverse, staleLockInverse, historicalPrefix, historicalFalseClaim, callbackControls, routingControls |
| runtime | exact keys execPath, execBytes, execSha256, version, platform, arch, cwd, argv, execArgv, environmentSha256, stdinKind, stdinWrites, stdinEofRequired |
| schema | exact string CESIUM_SUPPLY_INVERSE_RECORDER_REQUEST_V5 |
| sources | exact keys launcher, adapter, recorder, predicate; each is sourceTuple |
| toolchain | exact keys node, cargo, rustc; each has exact keys path, bytes, sha256, version |
| topology | exact keys orderedEntries, serializationBytes, serializationSha256, adapterManifestRows, rootManifestRows, noncircularRule |
| vendor | exact keys root, files, bytes, canonicalSha256, embeddedManifestBytes, embeddedManifestSha256, registryDirectories, registrySetSha256 |
| version | exact integer 5 |

recorderRegistration is observational duplicate data. sourceBytes/sourceSha256 must equal the
entry-validated capsule and recorder program tuple; r4ObservedBytes/r4ObservedSha256 must equal
the recorder's independently measured execArgv[4] tuple. Neither value is consulted before the
entry gate. The actual execution request contains no unresolved placeholder, sentinel, omitted
key, or guessed identity.

The exact authority values already known are:

| Key | Bytes | SHA-256 |
| --- | ---: | --- |
| v1Prefix | 26,451 | 9bba5c319832f75a65cc57770de8d755d35e94462a70f660cb3f80f0008b84fa |
| v2Prefix | 63,359 | be2f2ea6799499a87f2ace7801507470e2e84f6283132f6da4a464ea35ae5ec8 |
| v3Prefix | 91,574 | 559c23cf5ec4873dd8c673da7941971cab9d8a1c4683471c4568b81c31a5d780 |
| v4Prefix | 126,391 | 3b597ae14ad13ce2ac4fd3904b68428d6336c93cdc24cc687b08d6e4bb4a087a |

authority.v5 is this record's final pathTuple. authority.sourceFreeze is the immutable phase-A
prefix tuple defined in section 51, not the later full source-freeze tuple. Both are literal
before request creation. This prefix construction is the only allowed self-reference break.

bootstraps.s3 is the exact 675-byte / 17-LF / zero-CR / no-BOM / no-terminal-LF source with
SHA-256 1ce3f8054b49ba4541be453c2c1ca8779f39f8af2ed2137095081aef1a70d793.
bootstraps.b3 is the exact 3,516-byte / 84-LF / zero-CR / no-BOM / no-terminal-LF source with
SHA-256 33fb37473b6ef3fe03befffd1e67c18ab0e45f383f91146930958633c935b558.
bootstraps.r4Historical is the exact V4 7,220-byte / 155-LF / zero-CR / no-BOM /
no-terminal-LF source with SHA-256
bf7d864f92ed925cef1fedce30dd3cbc890af2ff2a5aae76d17908a725bab38d and is never executable
under V5. bootstraps.r4V5 is the literal new source tuple frozen after recorder V5. Every
sourceBase64 decodes to and rehashes as its same object.

censuses.grammar has exact keys pathForm, recordForm, ordinal, terminalLf, symlinkPolicy,
exclusions and exact values FORWARD_SLASH_RELATIVE_UTF8,
PATH_TAB_DECIMAL_BYTES_TAB_LOWER_SHA256_LF, UTF8_BYTE_ORDINAL_ASCENDING, true,
REJECT_SYMLINK_REPARSE_NONREGULAR_ALIAS, and
[vendor/**,target/**,output/**]. A census row is exactly
forward-path + TAB + canonical unsigned decimal byte count + TAB + lowercase SHA-256 + LF.
expectedBytes always means the complete canonical TSV serialization length, never aggregate
subject bytes. censuses.inputs fixes 13 rows / 1,312 bytes /
a3ab97284316b0c09edc271ae440dc92db0f7956e7d44e4a22ebcae1d8c762a6.
censuses.vendor fixes 1,383 rows, expectedBytes null, and
ca954a20ea857cc4e43e965d505671d56bcd9184095309311b66482d036f1f05.
censuses.firstParty has future row count, expectedBytes, and hash as literal null.
censuses.toolchain fixes three rows and has future expectedBytes/hash as literal null. The exact
census objects are:

| Census | beforePath | afterPath | expectedRows | expectedBytes | expectedSha256 |
| --- | --- | --- | ---: | ---: | --- |
| inputs | adapter/inputs.before.tsv | adapter/inputs.after.tsv | 13 | 1312 | a3ab97284316b0c09edc271ae440dc92db0f7956e7d44e4a22ebcae1d8c762a6 |
| vendor | adapter/vendor.before.tsv | adapter/vendor.after.tsv | 1383 | null | ca954a20ea857cc4e43e965d505671d56bcd9184095309311b66482d036f1f05 |
| firstParty | adapter/first-party.before.tsv | adapter/first-party.after.tsv | null | null | null |
| toolchain | adapter/toolchain.before.tsv | adapter/toolchain.after.tsv | 3 | null | null |

claimLimits is exactly, in this order:

~~~text
SOURCE_ONLY_INVERSE
NO_CARGO
NO_BUILD_TEST_PRODUCT
NO_CONTAINMENT_ZERO_SURVIVORS
NO_RELEASE_CERTIFICATION
~~~

cwd is exactly
F:\Dev\GH\cesium-webgpu\Tools\process-supervisor\output\supply-chain-durable-inverse-2026-08-31-v5\adapter.
deadlines has exactly these insertion-order key/value pairs:

~~~text
workerMs=20000
terminateReapMs=3000
drainMs=2000
ingressMs=5000
recorderChildMs=35000
recorderReapMs=3000
recorderForceReapMs=2000
recorderDrainMs=3000
adapterMs=60000
adapterChildMs=70000
adapterReapMs=3000
adapterForceReapMs=2000
adapterDrainMs=3000
launcherMs=85000
rootMs=100000
rootReapMs=5000
~~~

The two 2,000-ms force-reap windows start only after their separate 3,000-ms graceful windows
expire. A graceful window is never shortened, combined with, or renamed as a force window.

evidence has leaf equal to the V5 leaf above; allowedEntries=44, regularFiles=41, directories=3,
adapterManifestRows=25, and rootManifestRows=39. allowedNamesBytes and allowedNamesSha256 are
literal source-freeze values recomputed from the exact V5 topology. receiptRule is exactly
MANIFEST_EXCLUDES_SELF_AND_RECEIPT and createRule is exactly CREATE_NEW_NO_REUSE.

## 46. Exact request values, registrations, and deterministic derivations

inputs.canonicalBase64 decodes to the exact 1,312-byte canonical thirteen-row buffer with SHA-256
a3ab97284316b0c09edc271ae440dc92db0f7956e7d44e4a22ebcae1d8c762a6.
inputs.configBase64 decodes to 123 bytes /
992df442f8e3a3e2188c6088a75abaf7a6311926e02e1392d4090b1a5b27fd62.
inputs.lockBase64 decodes to 6,609 bytes /
681d72ab1726a739f5e9240ab1a9eca9a91e4bcfcab5456464cec8f5889a4a83.
inputs.historicalPrefixBase64 decodes to the corrected first 184,665 physical subject bytes /
49d84f2b35f27c063c8c69dceae91ad29ba41162216cc9efa2ffe7f8ed449486. The false
49d84f2b50a214019fcd00815d89469d6871471691fb9c03c88db834d4eb926b value is a mutant claim
only.

inputs.registrations is exactly this thirteen-object array in UTF-8 path ordinal order; commas in
displayed byte counts are presentation only:

| Ordinal | path | bytes | sha256 |
| ---: | --- | ---: | --- |
| 0 | ../../migration_doc/RUST_PROCESS_SUPERVISOR_CARGO_LOCK_REFRESH_PREREGISTRATION_2026-08-30.md | 9,547 | 8bf0681b1373f9f5f3d06654ecff88bcdfa0abbe1e1cae0131f9da73dd056f24 |
| 1 | .cargo/config.toml | 123 | 992df442f8e3a3e2188c6088a75abaf7a6311926e02e1392d4090b1a5b27fd62 |
| 2 | Cargo.lock | 6,609 | 681d72ab1726a739f5e9240ab1a9eca9a91e4bcfcab5456464cec8f5889a4a83 |
| 3 | Cargo.toml | 992 | 179c592964901b2abcbd432f904f92f546e16d14b8fd335fb4b9d51048f26e2d |
| 4 | SUPPLY_CHAIN.md | 195,674 | f7157f11b7e63e2228cf851b3b6edec30168817c9291eee2f1ac9c27201bbcb2 |
| 5 | crates/proc-supervisor-cli/Cargo.toml | 470 | 68c7c8a92251be922230ce67d339ce76affb7f3f2237dbbb3961604d905ccd03 |
| 6 | crates/q152-process-runner/Cargo.toml | 454 | 3b15ee3ad1fbad1711f7c549f76b05ca470b0f627c18d9c12f652d7adb1da1f0 |
| 7 | crates/supervisor-core/Cargo.toml | 235 | f967857f7d167d59668ed53e8321c953be0a25f99aed0651ad8e6c5ce268f09c |
| 8 | crates/supervisor-native/Cargo.toml | 406 | b286343a1f489c3110feb86847f9595c9ddeeec5937293a5851dc9dc9e924c73 |
| 9 | crates/supervisor-protocol/Cargo.toml | 362 | 63ca376b15e0183fc0e56a50938ae95f097aaea6fdc57af7af086b1066769c5f |
| 10 | crates/supervisor-test-child/Cargo.toml | 259 | 25b42df907e3a4a331e2fd2d7dfef520c74e103493646a7bb2a97940d4f7ff86 |
| 11 | rust-toolchain.toml | 87 | 6152f0907eaac1d9806d46246c4c9715bfdb7eaa400323a34b9f493ff0e6f946 |
| 12 | tests/Cargo.toml | 488 | 0aee198b9a84f4ccb75227bb9bbf87d520d7caf8f092a36a454dae6f97a67b82 |

limits has exactly these insertion-order key/value pairs. Every byte cap includes every retained
byte; request and recorder-result caps include their required terminal LF.

~~~text
predicateResultBytes=1048576
recorderResultBytes=16777216
requestBytes=1048576
workerStdoutBytes=4096
workerStderrBytes=8388608
workerMessageEncodedChars=1398104
recorderSourceBytes=32768
recorderFrameBytes=32873
adapterSourceBytes=18000
adapterEnvelopeChars=24576
childCommandLineUnits=30000
reasonCount=64
reasonChars=128
eventCount=64
nonceMinChars=16
nonceMaxChars=128
~~~

The reasonCount limit is the count of simultaneously true terminal facts, not the length of the
authoritative global vocabulary. Validation is fail-closed and phase-gated so mutually exclusive
causes and causally unstarted phases cannot inflate it. If the invariant would exceed 64, no
recorder result is authoritative or truncated; publication is withheld and the adapter derives
CHILD_RESULT_ABSENT.

metadata has these exact fixed values:

| Key | Exact value |
| --- | --- |
| stdoutPath | C:\Users\Kurt\AppData\Local\Temp\codex-rust-metadata-b16fd8a449b842639ea69b33c329c01d\metadata.stdout.json |
| stdoutBytes | 123501 |
| stdoutSha256 | 693093b689490c802805ccf2a8cbc36684a24afa53faa4a6204707d348ccfb4c |
| stderrPath | C:\Users\Kurt\AppData\Local\Temp\codex-rust-metadata-b16fd8a449b842639ea69b33c329c01d\metadata.stderr.bin |
| stderrBytes | 0 |
| stderrSha256 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| packages | 32 |
| registryPackages | 25 |
| workspaceMembers | 7 |
| resolverRule | LOCK_METADATA_VENDOR_EXACT_SET_EQUALITY |

metadata.registrySetSha256 is the source-freeze literal derived below and is never guessed from a
summary. Parse the one stable-read metadata stdout buffer as data-only JSON. Select exactly the 25
registry packages; for each serialize name + TAB + version + TAB + checksum + LF in UTF-8, sort
the complete record buffers by unsigned UTF-8 byte ordinal, concatenate once, and hash that one
buffer. Reject a missing/duplicate/non-string field, duplicate name/version, extra key used as
authority, noncanonical checksum, count other than 25, or disagreement with Cargo.lock and the 25
top-level versioned vendor directories.

runtime fixes execPath to C:\Program Files\nodejs\node.exe, execBytes=86997320,
execSha256=0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4,
version=v22.23.2, platform=win32, arch=x64, and cwd to the exact V5 adapter cwd above. argv is
exactly [C:\Program Files\nodejs\node.exe]. execArgv is exactly
[--no-addons,--no-warnings,--input-type=module,--eval,<literal R4-V5 source>].
environmentSha256 is 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a;
stdinKind=PIPE_ONE_WRITE_THEN_END, stdinWrites=1, and stdinEofRequired=true.

toolchain has these exact three objects:

| Key | path | bytes | sha256 | version |
| --- | --- | ---: | --- | --- |
| node | C:\Program Files\nodejs\node.exe | 86,997,320 | 0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4 | 22.23.2 |
| cargo | C:\Users\Kurt\.rustup\toolchains\1.94.0-x86_64-pc-windows-msvc\bin\cargo.exe | 30,754,304 | cbfdfc04b61ba49d184c6d3996502a00391d570cb5cb71a00faeb8c0ce12a4c9 | cargo 1.94.0 (85eff7c80 2026-01-15) |
| rustc | C:\Users\Kurt\.rustup\toolchains\1.94.0-x86_64-pc-windows-msvc\bin\rustc.exe | 111,104 | 6a0699e427ee9c1492ef1c9ea967d035dc4660e92c7fe32f2c6a1038116700e5 | rustc 1.94.0 (4a4ef493e 2026-03-02) |

The tools are stable-read and hashed as inert data. Cargo and rustc are never invoked.

predicate has path frozen/predicate.mjs, 17,955 bytes, SHA-256
dda9600272a3644f01fcc84cf845764ed7cb0f302574cd4abed8f0c471642428,
schema CESIUM_SUPPLY_INVERSE_PREDICATE_V3, and allowedImports exactly
[node:buffer,node:crypto,node:worker_threads]. recorder has path frozen/recorder.mjs, schema
CESIUM_SUPPLY_INVERSE_RECORDER_RESULT_V5, and its future literal tuple. For both program objects,
text is the exact strict UTF-8 source string; UTF-8(text) must equal bytes and sha256. The
recorder allowedImports are exactly
[node:buffer,node:crypto,node:fs,node:path,node:worker_threads].
The exact forbiddenLoads array for each is:

~~~text
dynamic-import-except-registered-data-url
eval
Function
node:vm
createRequire
require
process.dlopen
native-addon
ffi
WebAssembly
package-specifier
relative-code-path
absolute-code-path
file-url
network
fetch
shell
environment-selected-code
~~~

The sole exception is R4-V5's one data: URL import of the already registered, independently
framed recorder bytes. The predicate is started only as a Worker from its verified data-URL
source. No request string, environment value, pathname, package resolution, or message field can
select executable bytes.

sources uses exact evidence-relative paths frozen/launcher.mjs, frozen/adapter.mjs,
adapter/frozen/recorder.mjs, and adapter/frozen/predicate.mjs. launcher allowedImports are exactly
[node:buffer,node:child_process,node:crypto,node:fs,node:path]; adapter allowedImports are exactly
[node:buffer,node:child_process,node:crypto,node:fs,node:path]; recorder and predicate use the
arrays above. Every future tuple/count is a literal in source-freeze before request creation.

registrations.canonicalControls has exact keys validatorId, current, order, separator, terminal.
validatorId is canonical-thirteen-row-v3. Each control has exact keys bytes, sha256, accepted,
reason, rowCount:

| Control | bytes | sha256 | accepted | reason | rowCount |
| --- | ---: | --- | --- | --- | ---: |
| current | 1,312 | a3ab97284316b0c09edc271ae440dc92db0f7956e7d44e4a22ebcae1d8c762a6 | true | null | 13 |
| order | 1,312 | f69dbb979a02e48c4ae32b889a9d286ebd344678d5863136f10e408245805aca | false | NON_ORDINAL_ORDER | 2 |
| separator | 1,312 | b34460cce801853530142c41dd54b21657f20ec950f7b65aeaf9db117eb6327f | false | BAD_SEPARATOR | 0 |
| terminal | 1,311 | 1e091b3b84c79225a0dc8388ca3aed3088782411529c641fea96713e38e46d90 | false | MISSING_TERMINAL_LF | 0 |

The inverse reusable shapes are exact:

| Object | Exact insertion-order keys |
| --- | --- |
| identity | path, bytes, sha256 |
| mutation | kind, offset, before, after, changedBytes |
| removal | offset, bytes, hex, base64 |
| mismatch | count, paths |
| callback | before, after, nonces |
| routing identity | name, bytes, sha256 |

paths and nonces are exact arrays; before/after/count/offset/bytes/changedBytes are nonnegative safe
integers; before and after in mutation are byte integers 0..255.

registrations.configInverse has exact keys live, mutation, mutant, tuple, mismatch, callback.
live is identity [.cargo/config.toml,123,
992df442f8e3a3e2188c6088a75abaf7a6311926e02e1392d4090b1a5b27fd62].
mutation is kind=XOR, offset=0, before=91, after=90, changedBytes=1. mutant is tuple
[123,3d00279785e55a40d6e5f702d91810965b00a438bafc265fa3333d7f0a36d782].
tuple is [1312,c456f53797584d1c97f82876579e2af828e731802b968c33874655a39663fcbd].
mismatch is count=1, paths=[.cargo/config.toml]. callback is before=0, after=0, nonces=[].

registrations.staleLockInverse has exact keys live, removals, removedBytes, mutant, tuple,
mismatch, callback. live is identity [Cargo.lock,6609,
681d72ab1726a739f5e9240ab1a9eca9a91e4bcfcab5456464cec8f5889a4a83]. removals is this
three-object array in descending offset order:

| offset | bytes | hex | base64 |
| ---: | ---: | --- | --- |
| 2603 | 16 | 202277696e646f77732d737973222c0a | ICJ3aW5kb3dzLXN5cyIsCg== |
| 2528 | 9 | 202273686132222c0a | ICJzaGEyIiwK |
| 2369 | 9 | 202273686132222c0a | ICJzaGEyIiwK |

removedBytes=34. mutant is tuple
[6575,f786d3ec5ae18179b94b2710d9a565c33843e9db4546a65e28488c3f50822023].
tuple is [1312,1d2d869032320fb50ac7f23b2fbaba480820e8f3aebf7b344952d25de20cfb58].
mismatch is count=1, paths=[Cargo.lock]. callback is before=0, after=0, nonces=[].

registrations.historicalPrefix has exact keys subject, tuple, mismatch, callback. subject is
[184665,49d84f2b35f27c063c8c69dceae91ad29ba41162216cc9efa2ffe7f8ed449486].
tuple is [1312,c1abf90fc4f3eaea63c4fb3e3be8d219bd1028cc1e09f319bc7173061c81ca6f].
mismatch is count=1, paths=[SUPPLY_CHAIN.md]. callback is before=0, after=0, nonces=[].
registrations.historicalFalseClaim has exact keys expectedSha256, observedSha256,
changedSubjectBytes, reason and values
49d84f2b50a214019fcd00815d89469d6871471691fb9c03c88db834d4eb926b,
49d84f2b35f27c063c8c69dceae91ad29ba41162216cc9efa2ffe7f8ed449486, 0, and
HISTORICAL_PREFIX_HASH_MISMATCH.

registrations.callbackControls has exact keys live, inert, bypass, overfire, directRoute,
wrongNonce, substitution. Each value has the callback shape. live is 0 -> 1 with the exact run
nonce as its sole nonce; every real inverse is 0 -> 0 with []; the synthetic bypass, overfire,
direct-route, wrong-nonce, and substitution values are exact source-freeze literals exercising
their named predicate branches and cannot reuse a real inverse observation.

registrations.routingControls has exact keys routeId, checkerId, currentNominal, bypassCount,
bypassIdentities, accepted, rejected, reason. routeId=route-v3, checkerId=bypass,
currentNominal=true, bypassCount=3, bypassIdentities is exactly
[order/1312/f69dbb979a02e48c4ae32b889a9d286ebd344678d5863136f10e408245805aca,
separator/1312/b34460cce801853530142c41dd54b21657f20ec950f7b65aeaf9db117eb6327f,
terminal/1311/1e091b3b84c79225a0dc8388ca3aed3088782411529c641fea96713e38e46d90]
as routing-identity objects; accepted=false, rejected=true, and
reason=MALFORMED_VALIDATOR_ROUTE_BYPASS.

vendor.root=vendor, vendor.files=1383, vendor.bytes=30423571,
vendor.canonicalSha256=ca954a20ea857cc4e43e965d505671d56bcd9184095309311b66482d036f1f05,
and vendor.registryDirectories=25. vendor.bytes remains aggregate file-content bytes; it is never
substituted for a canonical TSV serialization length. embeddedManifestBytes,
embeddedManifestSha256, and registrySetSha256 are literal source-freeze results, never guesses.

The embedded-manifest derivation is one-buffer and deterministic. Source-freeze stable-reads the
registered 195,674-byte SUPPLY_CHAIN.md through one handle into one immutable buffer, verifies its
registered tuple, and records exact decimal start/end byte offsets plus the exact opening and
closing delimiter byte strings. It takes one subarray between those delimiters, requires strict
UTF-8/no-BOM/no-CR/exact terminal LF, parses exactly 1,383
path/TAB/decimal-bytes/TAB/lowercase-hash/LF rows, requires strict UTF-8 byte-ordinal path order
and canonical one-buffer reserialization equality, and hashes that same subarray. No line API,
regex-selected alternate block, platform newline conversion, reconstructed summary, or second
read may supply these values. Source-freeze also serializes the independently observed vendor
tree into one buffer by the same rule and requires exact byte equality with that extracted
subarray. The final offsets, delimiter bytes, serialization length, and hash must be literal in
phase A before source release.

topology.orderedEntries is exactly this 44-object array. Each object has exact keys type,path;
type is D or F and path is the printed forward-slash string. The displayed order is already
unsigned UTF-8 byte ordinal:

~~~text
D	adapter/
D	adapter/frozen/
D	frozen/
F	adapter-bootstrap.mjs
F	adapter-child.argv.json
F	adapter-child.observation.json
F	adapter-child.stderr.bin
F	adapter-child.stdout.bin
F	adapter-envelope.b64
F	adapter/adapter-invocation.json
F	adapter/artifact-manifest.tsv
F	adapter/executor.after.json
F	adapter/executor.before.json
F	adapter/first-party.after.tsv
F	adapter/first-party.before.tsv
F	adapter/frozen/predicate.mjs
F	adapter/frozen/recorder.mjs
F	adapter/inputs.after.tsv
F	adapter/inputs.before.tsv
F	adapter/metadata.stderr.bin
F	adapter/metadata.stdout.json
F	adapter/predicate.stderr.bin
F	adapter/predicate.stdout.bin
F	adapter/receipt.json
F	adapter/recorder-bootstrap.mjs
F	adapter/recorder-child.argv.json
F	adapter/recorder-child.observation.json
F	adapter/recorder-child.stderr.bin
F	adapter/recorder-child.stdout.bin
F	adapter/recorder-envelope.bin
F	adapter/request.json
F	adapter/result.json
F	adapter/toolchain.after.tsv
F	adapter/toolchain.before.tsv
F	adapter/vendor.after.tsv
F	adapter/vendor.before.tsv
F	artifact-manifest.tsv
F	frozen/adapter.mjs
F	frozen/launcher.mjs
F	launcher-invocation.json
F	receipt.json
F	shell-command.ps1
F	shell-tcb.json
F	source-freeze.tsv
~~~

The canonical allowed-name buffer is exactly type + TAB + path + LF for each row. V5
serializationBytes and serializationSha256 are recomputed from this one buffer only after all
V5 names and sources freeze; the V4 1,194-byte/hash sentry is not imported as evidence even if a
recomputation happens to match its byte count. adapterManifestRows=25, rootManifestRows=39, and
noncircularRule=TWO_MANIFESTS_EXCLUDE_SELF_AND_RECEIPT. The adapter manifest hashes its 25
earlier regular files and excludes only adapter/artifact-manifest.tsv and adapter/receipt.json.
The root manifest hashes its 39 earlier regular files and excludes only artifact-manifest.tsv and
receipt.json. Neither manifest lists directories, no file hashes itself, and both receipts bind
only an already-closed manifest.

protocol.requestSchema, recorderResultSchema, recorderCapFallbackSchema, predicateResultSchema,
and messageEnvelopeSchema are exactly the five identifiers in section 43. protocol.reasonOrder
is the complete string array in section 50; protocol.reasonClasses is a plain object with those
same keys in that order and exact values STRUCTURAL, ERROR, or FAIL from section 50.
protocol.statusOrder is exactly [PASS,FAIL,ERROR,STRUCTURAL]. protocol.exitMap has exact
insertion-order keys PASS,FAIL,ERROR,STRUCTURAL with integer values 0,1,2,3. The request's protocol
object is a checked copy only. Recorder and adapter embedded constants are authority and must be
byte-for-byte identical; source-freeze crosschecks both.

## 47. Exact Worker, message, predicate-result, and comparison schemas

Worker workerData is one plain frozen object with exact insertion-order keys:

~~~text
canonicalBase64, configBase64, historicalPrefixBase64, lockBase64, nonce, version
~~~

The four Base64 strings decode canonically to the registered input buffers above. nonce is the
request nonce. version is exactly CESIUM_SUPPLY_INVERSE_PREDICATE_V3. The Worker source is the
one registered predicate buffer converted to one data: URL; no pathname or package code load is
allowed. The predicate's process.execArgv is exactly [--no-addons,--no-warnings].

Exactly one Worker message is permitted. The message is a plain object with exact insertion-order
keys jsonBase64,jsonSha256. jsonBase64 is a nonempty canonical padded Base64 string of at most
1,398,104 characters whose decoded bytes are 1..1,048,576 bytes. jsonSha256 is the lowercase hash
of those decoded bytes. Decoded result bytes are strict UTF-8, no BOM, no CR, no terminal LF, and
exactly UTF-8(JSON.stringify(parsedResult)); parsing and canonical reserialization must reproduce
every byte. A missing message is MESSAGE_ABSENT/ERROR. More than one is
MESSAGE_MULTIPLE/STRUCTURAL; after the second message cancellation latches and no later message
can replace the first observation.

The accepted predicate result has these exact insertion-order key sets:

| Object | Exact insertion-order keys |
| --- | --- |
| top | schema, nonce, validatorId, status, exit, reasons, controls, inverses |
| controls | runtime, malformedRouting, liveSyntax, malformed, liveRun, inert, bypass, overfire, directRoute, wrongNonce, historicalPositive, historicalFalseClaim, substitution |
| runtime | expected, observed, accepted, reason |
| validator reject | validatorId, bytes, sha256, accepted, reason, rowCount |
| validator accept | validatorId, bytes, sha256, accepted, reason, rowCount, rows |
| canonical row | path, bytes, sha256 |
| malformed | order, separator, terminal |
| routing | routeId, checkerId, currentNominal, bypassCount, bypassIdentities, accepted, rejected, reason |
| bypass identity | name, bytes, sha256 |
| gate run | gate, callbackBefore, callbackAfter, callbackNonces |
| identity gate | syntax, accepted, launchPermitted, mismatches |
| nonvacuity | accepted, changedBytes, mutantBytes, mutantSha256, tupleBytes, tupleSha256 |
| canary | accepted, reason |
| historical | accepted, bytes, changedSubjectBytes, observedSha256, expectedSha256, reason |
| inverses | config, staleLock |
| inverse | nonvacuity, run |

schema is CESIUM_SUPPLY_INVERSE_PREDICATE_V3; validatorId is
canonical-thirteen-row-v3; nonce is the exact projected request nonce or exact null only in a
controlled preprojection exception. status is one of PASS,FAIL,ERROR,STRUCTURAL and exit is the
matching 0,1,2,3. reasons is an ordered array of at most 64 registered strings, each at most 128
characters. Every boolean, null, integer, string, array, tuple, hash, key order, nested
cardinality, registered identity, callback transition, and mismatch array is independently
validated; no selected accepted/status/exit/reason value stands for its underlying primitives.

A complete measurement has nonnull controls and inverses and every nested object above. A
controlled exception has controls=null and inverses=null and the same top keys. The exact
structural exception allowlist, in order, is:

~~~text
PARENT_PORT_ABSENT
WORKER_DATA_SCHEMA
WORKER_DATA_KEYS
WORKER_DATA_VERSION
NONCE_FORM
CANONICAL_BASE64_FORM
CANONICAL_BASE64_SIZE
CANONICAL_BASE64_CANONICAL
CONFIG_BASE64_FORM
CONFIG_BASE64_SIZE
CONFIG_BASE64_CANONICAL
LOCK_BASE64_FORM
LOCK_BASE64_SIZE
LOCK_BASE64_CANONICAL
HISTORICAL_PREFIX_BASE64_FORM
HISTORICAL_PREFIX_BASE64_SIZE
HISTORICAL_PREFIX_BASE64_CANONICAL
CANONICAL_ROWS_ABSENT
CANONICAL_TAB_ABSENT
CURRENT_CANONICAL_UNAVAILABLE
STALE_LOCK_LITERAL_MISMATCH
~~~

Exactly one such result reason derives that same structural fact. Any other predicate exception
text, including a size-cap/runtime string, is never copied into outer output and derives only
PREDICATE_UNREGISTERED_EXCEPTION/ERROR.

For a complete result the recorder derives predicate structural reasons from primitives in this
exact order:

~~~text
PROCESS_EXECARGV_CONTROL
CURRENT_CANONICAL
ORDER_CONTROL
SEPARATOR_CONTROL
TERMINAL_CONTROL
MALFORMED_ROUTING_CONTROL
CONFIG_LIVE_IDENTITY
CONFIG_TUPLE_SYNTAX
LOCK_LIVE_IDENTITY
LOCK_TUPLE_SYNTAX
LIVE_GATE
INERT_CONTROL
BYPASS_CONTROL
OVERFIRE_CONTROL
DIRECT_ROUTE_CONTROL
WRONG_NONCE_CONTROL
HISTORICAL_POSITIVE
HISTORICAL_FALSE_CLAIM
HISTORICAL_TUPLE
SUBSTITUTION_CONTROL
~~~

The predicate-selected reasons array is compared only with that independently derived structural
array, or with the one controlled structural exception code. CONFIG_INVERSE_RED then
STALE_LOCK_INVERSE_RED are independently derived product facts from the complete registered
inverse primitives. They affect derived predicate and outer status but are absent from the
predicate reasons comparison. Thus a valid complete product red may have selected reasons=[] and
selected status=FAIL/exit=1.

After deriving structural and product facts, the recorder derives predicate status and exit:
STRUCTURAL if any predicate structural fact exists; otherwise FAIL if either complete valid
product-red fact exists; otherwise PASS. A controlled unregistered/runtime exception derives
ERROR. Only then are selected reasons, status, and exit compared. Disagreement adds, in order,
PREDICATE_SELECTED_REASONS, PREDICATE_SELECTED_STATUS, and PREDICATE_SELECTED_EXIT as applicable.
The Worker physical exit code must independently equal the derived predicate exit 0, 1, 2, or 3;
any of those four is valid when it matches. A mismatch is WORKER_EXIT_CODE/ERROR when an observed
Worker runtime termination prevents a trustworthy predicate exit, otherwise
PREDICATE_SELECTED_EXIT/STRUCTURAL.

Worker stdout is exactly
JSON.stringify({schema,nonce,status,exit,resultBytes,resultSha256}) + LF, no BOM and no CR, and at
most 4,096 bytes including LF. Object keys are exactly in the printed order; schema is
CESIUM_SUPPLY_INVERSE_PREDICATE_V3, resultBytes and resultSha256 describe the decoded message
bytes, and all four selected fields must match the recursively validated result. Worker stderr is
exactly empty on a complete PASS/FAIL/STRUCTURAL/controlled-ERROR publication. Any stderr byte is
STDERR_UNEXPECTED/STRUCTURAL after its separately bounded stream capture.

## 48. Exact recorder result and cap-fallback protocols

The full recorder result is one plain object with these exact insertion-order keys:

~~~text
schema, nonce, status, exit, reasons, recorder, request, predicate, protocol,
runtime, envelope, lifecycle, messageCardinality, predicateResult, streams,
claimLimits
~~~

schema is CESIUM_SUPPLY_INVERSE_RECORDER_RESULT_V5. nonce is the exact request nonce or null only
before a valid request projects it. status/exit are the final independently folded pair.
reasons is GLOBAL_REASON_ORDER filtered by the closed boolean fact map, never event-push order and
never attacker text. It contains no duplicate, at most 64 items, and each item is at most 128
ASCII characters. protocol is the exact recorder-embedded object from sections 46 and 50;
claimLimits is always the exact five-string array in section 45.

The exact nested schemas are:

| Object | Exact insertion-order keys |
| --- | --- |
| recorder | registrationSchema, sourceBytes, sourceSha256, r4ObservedBytes, r4ObservedSha256, capsule |
| capsule | eofObserved, frameBytes, frameSha256, headerBytes, headerSha256, registrationSchema, registeredSourceBytes, registeredSourceSha256, sourceBase64, sourceBytes, sourceSha256 |
| stable identity | dev, ino, nlink, mode, size |
| stable read | path, scopeRoot, realPath, openIdentity, closeIdentity, bytes, sha256, regular, symlink, reparse, stable |
| request | stableRead, schema, version, canonical |
| predicate | stableRead, registrationBytes, registrationSha256 |
| runtime | entryExpected, entryObserved, predicateExpected, predicateObserved |
| runtime observation | execPath, execBytes, execSha256, version, platform, arch, cwd, argv, execArgv, environment, environmentSha256 |
| envelope | keys, encodedChars, decodedBytes, decodedSha256 |
| streams | stdout, stderr |

stable identity values are canonical unsigned decimal strings for dev, ino, nlink, mode, and
size so no JavaScript precision conversion occurs. openIdentity and closeIdentity must be
identical; regular=true, symlink=false, reparse=false, stable=true; realPath must be in scope and
must not alias a different registered object. stable read bytes and sha256 describe the one
immutable read buffer. A syscall inability is ERROR; scope escape, link/reparse/nonregular,
alias, identity, growth, replacement, or instability is STRUCTURAL.

request.schema/version/canonical must be
CESIUM_SUPPLY_INVERSE_RECORDER_REQUEST_V5/5/true. predicate.registrationBytes and
registrationSha256 are recorder constants and must equal the stable-read predicate tuple.
runtime.entryExpected is the recorder/R4 constant and entryObserved is independently captured
before request read. predicateExpected is the frozen [--no-addons,--no-warnings] Worker
expectation and predicateObserved is the predicate result's runtime object after recursive
validation. Environment is a plain ordinal string map and is exactly {} for entryExpected and
entryObserved.

envelope.keys is exactly [jsonBase64,jsonSha256]. encodedChars is the message Base64 character
count. decodedBytes and decodedSha256 are the predicate-result buffer tuple. messageCardinality is
an integer 0..64 when the Worker phase started, and exact null otherwise. predicateResult is the
complete recursively validated predicate object, or the unavailable object. recorder, request,
predicate, runtime, envelope, lifecycle, predicateResult, and streams may use unavailable only
when the named phase was causally unstarted. The unavailable value identifies the already present
cause by not_attempted_due_to and adds no missing-phase cascade reason.

Canonical full-result serialization is exactly
UTF-8(JSON.stringify(validatedFullResult)) + one 0x0a. It is strict UTF-8, no BOM, no CR, and
exactly one terminal LF. The candidate is completely constructed and validated in immutable plain
data, then serialized once and measured including LF. If it is at most 16,777,216 bytes it is the
sole stdout result line.

If the measured full candidate exceeds 16,777,216 bytes, the recorder sets
RECORDER_RESULT_CAP=true and discards that candidate for publication. It then creates exactly one
fallback object with these insertion-order keys:

~~~text
schema, nonce, status, exit, reasons, candidate, claimLimits
~~~

schema is CESIUM_SUPPLY_INVERSE_RECORDER_CAP_FALLBACK_V1. candidate has exact insertion-order keys
bytes,sha256,capBytes. bytes and sha256 describe the complete over-cap canonical candidate
including its LF; capBytes=16777216. reasons is the re-filtered authoritative fact map including
RECORDER_RESULT_CAP and every already-derived retained FAIL/ERROR/STRUCTURAL fact. status is the
maximum of those fixed classifications and exit is its matching value; fallback never
unconditionally forces ERROR and never demotes an existing STRUCTURAL. The fallback is serialized
by the same canonical line rule, remeasured, and must itself fit the same cap.

There is one publication attempt: set process.exitCode to the intended derived exit, invoke one
stdout write with the selected full or fallback buffer, and observe its callback. No second result
write is permitted. A synchronous write throw is RECORDER_STDOUT_SYNC; callback failure is
RECORDER_STDOUT_CALLBACK. Failure to serialize the full candidate, fit/serialize the fallback, or
publish a complete line yields no authoritative recorder result; the adapter retains actual bytes
and derives the corresponding finalization/child reason. No unhandled rejection, exception text,
partial JSON repair, or synthesized second line is accepted.

## 49. Exact lifecycle, event, stream, and child-observation schemas

lifecycle has these exact insertion-order keys:

~~~text
workerDeadlineMs, terminateReapMs, streamDrainMs, startMonotonicNs,
startWallUtc, endMonotonicNs, endWallUtc, timedOut, cancellationLatched,
workerErrorObserved, terminalObserved, workerExitCode, terminateRequested,
terminateCallThrew, terminateResolved, terminateRejected, terminateExitCode,
terminateSettlementComplete, reapComplete, stdoutDestroyRequested,
stderrDestroyRequested, drainComplete, eventAcceptanceClosed, listenersDetached,
capturesSealed, eventLogComplete, events
~~~

The three limits are 20000, 3000, and 2000. Monotonic values are unsigned decimal-nanosecond
strings from one monotonic clock; wall values are UTC ISO-8601 strings used only for correlation,
never deadlines. end values and workerExitCode/terminateExitCode are exact null until observed.
Every other state field is an exact boolean. events is an array of at most 64 event objects with
exact keys index,name,monotonicNs,wallUtc. index is consecutive from zero and the two time fields
obey the same types above. name is exactly one of:

~~~text
WORKER_CREATED
HANDLERS_ATTACHED
MESSAGE
WORKER_ERROR
WORKER_EXIT
STDOUT_END
STDOUT_ERROR
STDOUT_CLOSE
STDOUT_CAP
STDERR_END
STDERR_ERROR
STDERR_CLOSE
STDERR_CAP
WORKER_DEADLINE
CANCELLATION_LATCHED
TERMINATE_REQUESTED
STDOUT_DESTROY_REQUESTED
STDERR_DESTROY_REQUESTED
TERMINATE_RESOLVED
TERMINATE_REJECTED
REAP_ADJUDICATED
DRAIN_ADJUDICATED
SNAPSHOT_BEGIN
~~~

Slot 63 is reserved for SNAPSHOT_BEGIN. Any earlier event that would consume that reserved slot
sets WORKER_EVENT_CAP, latches cancellation, and is not appended. SNAPSHOT_BEGIN is the final
accepted event. In the same synchronous turn the recorder then sets eventAcceptanceClosed=true,
detaches every listener, seals both captures, copies every report value into plain immutable
data, freezes events and reasons, and begins serialization. No promise continuation or late
Worker/stream/terminate event may mutate those values. A late-mutation biting control must prove a
post-close event leaves canonical bytes unchanged; otherwise LATE_EVENT_MUTATION/STRUCTURAL.

The Worker state machine is exact:

1. Construct the Worker and attach message, Worker error/exit, stdout, and stderr handlers before
   awaiting anything.
2. Wait for the first physical Worker exit, latched fault, or absolute 20,000-ms deadline. A
   Worker/stream/message/protocol/cap fault or deadline latches cancellation once.
3. On cancellation call Worker.terminate exactly once and destroy stdout/stderr exactly once
   before the reap wait. Terminate continuations update only a private deferred outcome.
4. Wait at most 3,000 ms for both the physical Worker exit event and, if requested, terminate
   settlement. A resolved terminate promise is not an exit observation. reapComplete=true only
   after physical exit.
5. Then wait at most 2,000 ms for both stream close events. Error never settles a stream. At the
   drain deadline destroy any undestroyed stream and retain ERROR.
6. Adjudicate reap/drain, append SNAPSHOT_BEGIN, close acceptance, detach, seal, snapshot, fold,
   and serialize in that order.

Each stdout/stderr capture has these exact insertion-order keys:

~~~text
base64, retainedBytes, retainedSha256, observedBytes, observedSha256,
capBytes, capExceeded, retentionTruncated, destroyRequested, endObserved,
errorObserved, closeObserved, cancelled, complete, drainComplete
~~~

base64 is the retained prefix in canonical padded Base64. retainedBytes is its decoded length and
retainedSha256 its hash. observedBytes is the full received extent and observedSha256 is the
incremental hash of exactly that received extent, including bytes beyond retention. retainedBytes
is min(observedBytes,capBytes); retentionTruncated is exactly observedBytes>retainedBytes and
capExceeded is exactly observedBytes>capBytes. stdout capBytes=4096 and stderr capBytes=8388608.
The first over-cap chunk retains only the remaining prefix, hashes/counts the whole observed
chunk, records the cap event/reason, and latches cancellation. No extent is silently dropped from
observedBytes/observedSha256.

Healthy complete means endObserved && closeObserved && !errorObserved && !capExceeded &&
!cancelled && !destroyRequested && retainedBytes===observedBytes. drainComplete requires physical
close. Any error, premature close, cap, destruction, cancellation, or missing end/close remains
explicit and cannot be represented as complete. After capturesSealed, no counter, digest,
retained byte, flag, or event changes.

adapter/recorder-child.observation.json and the launcher's adapter-child.observation.json each use
this exact top schema:

~~~text
schema, nonce, status, exit, reasons, spawn, stdin, stdout, stderr, lifecycle,
resultCardinality, result
~~~

schema is CESIUM_SUPPLY_INVERSE_RECORDER_CHILD_OBSERVATION_V5 for the recorder child and
CESIUM_SUPPLY_INVERSE_ADAPTER_CHILD_OBSERVATION_V5 for the adapter child. spawn has exact keys
execPath,cwd,argv,execArgv,environment,stdio,shell,windowsHide. stdin has exact keys
frameBytes,frameSha256,writes,endRequested,writeSettled,endSettled. stdout and stderr use the
extent-aware stream schema above. Both child stdout caps are 16777216 and both child stderr caps
are 8388608. adapterEnvelopeChars=24576 is only the launcher's encoded adapter-envelope argument
cap; it is never an output-stream cap. lifecycle has exact keys
deadlineMs,gracefulReapMs,forceReapMs,drainMs,startMonotonicNs,startWallUtc,endMonotonicNs,
endWallUtc,timedOut,gracefulTerminateRequested,forceTerminateRequested,exitObserved,exitCode,
signal,stdinSettled,reapComplete,drainComplete,eventAcceptanceClosed,capturesSealed,events.
signal and exitCode are exact null or the observed string/integer. Child events use exact
index,name,monotonicNs,wallUtc objects. Their closed name enum, in order, is:

~~~text
CHILD_SPAWNED
STDIN_WRITE_REQUESTED
STDIN_WRITE_SETTLED
STDIN_END_REQUESTED
STDIN_END_SETTLED
CHILD_ERROR
CHILD_EXIT
CHILD_STDOUT_END
CHILD_STDOUT_ERROR
CHILD_STDOUT_CLOSE
CHILD_STDOUT_CAP
CHILD_STDERR_END
CHILD_STDERR_ERROR
CHILD_STDERR_CLOSE
CHILD_STDERR_CAP
CHILD_DEADLINE
GRACEFUL_TERMINATE_REQUESTED
FORCE_TERMINATE_REQUESTED
CHILD_REAP_ADJUDICATED
CHILD_DRAIN_ADJUDICATED
SNAPSHOT_BEGIN
~~~

No per-chunk data event is emitted; extent/hash counters are the data observation. The same
64-event cap with slot 63 reserved for SNAPSHOT_BEGIN, final-event rule, and late immutability
rules apply.

For the recorder child, deadlineMs=35000, gracefulReapMs=3000, forceReapMs=2000, drainMs=3000.
For the adapter child, deadlineMs=70000, gracefulReapMs=3000, forceReapMs=2000, drainMs=3000.
Each owner retains its exact ChildProcess object. A deadline begins at spawn return and is not
reset by progress. Graceful termination is requested once; only after its separate 3,000-ms
window expires may force termination be requested once; the 2,000-ms force window does not erase
or rename the graceful observation. Physical exit, both pipe closes, and stdin settlement are
distinct. An incomplete reap or drain is ERROR and never claims zero survivors.

The adapter stdout success summary is one strict canonical JSON/LF line with exact keys
schema,nonce,status,exit,receiptBytes,receiptSha256. schema is
CESIUM_SUPPLY_INVERSE_ADAPTER_SUMMARY_V5; nonce is the request nonce; status/exit are the
adapter's independently derived pair; receiptBytes/receiptSha256 bind the already closed exact
adapter/receipt.json bytes. Its stderr is exactly empty. resultCardinality is the number of
complete canonical result lines observed. result is one recursively validated recorder
full/fallback object, one recursively validated adapter summary, or unavailable. Zero yields
CHILD_RESULT_ABSENT/ERROR; more than one yields
CHILD_RESULT_MULTIPLE/STRUCTURAL. One otherwise-valid recorder result followed by observed child
exit 2 yields CHILD_POST_RESULT_ERROR/ERROR while retaining the result's existing facts. Any other
unexplained result/exit disagreement yields CHILD_EXIT_MISMATCH/STRUCTURAL. Pipe syscall,
deadline, termination, reap, and drain failures are ERROR; protocol/cardinality/topology/identity
faults are STRUCTURAL.

The adapter embeds and applies the authoritative global reason list. The launcher does not
reinterpret recorder internals or copy a request-selected fold; it max-folds only independently
observed adapter result/exit, raw streams, lifecycle, manifest, receipt, topology, and census
facts. A phase that is causally unstarted is represented by unavailable/not_attempted_due_to and
adds no message, stream, child, or topology cascade reason.

## 50. One authoritative global reason order and total outer fold

The following table is the complete authoritative order. S means STRUCTURAL/3, E means ERROR/2,
and F means FAIL/1. protocol.reasonOrder is the code column concatenated from top to bottom;
protocol.reasonClasses maps each code to the expanded status. No other code is registered.

~~~text
R4_ARGV S
R4_EXECARGV S
R4_STDIN_TOPOLOGY S
R4_FRAME_SIZE S
R4_MAGIC S
R4_HEADER S
R4_LENGTH_EMPTY S
R4_LENGTH_LEADING_ZERO S
R4_LENGTH_BYTE S
R4_BYTE_LENGTH S
R4_HASH_LENGTH S
R4_HASH_BYTE S
R4_SOURCE_LENGTH S
R4_TRAILING_DATA S
R4_BOM S
R4_CR S
R4_TERMINAL_LF S
R4_UTF8 S
R4_HASH S
R4_HEADER_RESERIALIZE S
R4_REGISTERED_SOURCE_BYTES S
R4_REGISTERED_SOURCE_SHA256 S
R4_EOF_REQUIRED S
R4_CAPSULE S

R4_INGRESS_TIMEOUT E
R4_STDIN_CHUNK_TYPE E
R4_STDIN_ERROR E
R4_STDIN_ABORTED E
R4_STDIN_CLOSE_BEFORE_EOF E
R4_STDIN_CLEANUP E
R4_IMPORT E
R4_REPORT_IO E

ENTRY_ARGV S
ENTRY_EXECARGV_SHAPE S
ENTRY_RUNTIME S
ENTRY_CWD S
ENTRY_ENVIRONMENT S
ENTRY_CAPSULE_DESCRIPTOR S
ENTRY_CAPSULE_KEYS S
ENTRY_REGISTRATION_SCHEMA S
ENTRY_SOURCE_BASE64_FORM S
ENTRY_SOURCE_BASE64_SIZE S
ENTRY_SOURCE_BASE64_CANONICAL S
ENTRY_SOURCE_TEXT S
ENTRY_SOURCE_BYTES S
ENTRY_SOURCE_SHA256 S
ENTRY_HEADER_REBUILD S
ENTRY_FRAME_REBUILD S
ENTRY_EOF S
ENTRY_SOURCE_REGISTRATION S

REQUEST_SCOPE S
REQUEST_ESCAPE S
REQUEST_ALIAS_OR_REPARSE S
REQUEST_NONREGULAR_OR_LINK S
REQUEST_SIZE S
REQUEST_OPEN_IO E
REQUEST_IDENTITY S
REQUEST_READ_IO E
REQUEST_SHORT_READ E
REQUEST_GREW S
REQUEST_UNSTABLE S
REQUEST_CLOSE_IO E
REQUEST_TEXT S
REQUEST_JSON S
REQUEST_CANONICAL S
REQUEST_KEYS S

REQUEST_AUTHORITY S
REQUEST_BOOTSTRAPS S
REQUEST_CENSUSES S
REQUEST_CLAIM_LIMITS S
REQUEST_CWD S
REQUEST_DEADLINES S
REQUEST_ENVIRONMENT S
REQUEST_EVIDENCE S
REQUEST_INPUTS S
REQUEST_LIMITS S
REQUEST_METADATA S
REQUEST_NONCE S
REQUEST_PREDICATE S
REQUEST_PROTOCOL S
REQUEST_RECORDER S
REQUEST_RECORDER_REGISTRATION S
REQUEST_REGISTRATIONS S
REQUEST_RUNTIME S
REQUEST_SCHEMA S
REQUEST_SOURCES S
REQUEST_TOOLCHAIN S
REQUEST_TOPOLOGY S
REQUEST_VENDOR S
REQUEST_VERSION S

PREDICATE_SCOPE S
PREDICATE_ESCAPE S
PREDICATE_ALIAS_OR_REPARSE S
PREDICATE_NONREGULAR_OR_LINK S
PREDICATE_SIZE S
PREDICATE_OPEN_IO E
PREDICATE_IDENTITY S
PREDICATE_READ_IO E
PREDICATE_SHORT_READ E
PREDICATE_GREW S
PREDICATE_UNSTABLE S
PREDICATE_CLOSE_IO E
PREDICATE_TEXT S
PREDICATE_REGISTRATION S

WORKER_CONSTRUCT E
WORKER_HANDLER_ATTACH E
WORKER_EVENT_CAP E
MESSAGE_ABSENT E
MESSAGE_MULTIPLE S
MESSAGE_KEYS S
MESSAGE_BASE64_FORM S
MESSAGE_BASE64_SIZE S
MESSAGE_BASE64_CANONICAL S
MESSAGE_HASH S
MESSAGE_TEXT S
MESSAGE_JSON S
MESSAGE_CANONICAL S
PREDICATE_RESULT_KEYS S
PREDICATE_RESULT_SCHEMA S
PREDICATE_RESULT_NONCE S
PREDICATE_RESULT_VALIDATOR S
PREDICATE_RESULT_REASONS S
PREDICATE_RESULT_CONTROLS S
PREDICATE_RESULT_INVERSES S

PARENT_PORT_ABSENT S
WORKER_DATA_SCHEMA S
WORKER_DATA_KEYS S
WORKER_DATA_VERSION S
NONCE_FORM S
CANONICAL_BASE64_FORM S
CANONICAL_BASE64_SIZE S
CANONICAL_BASE64_CANONICAL S
CONFIG_BASE64_FORM S
CONFIG_BASE64_SIZE S
CONFIG_BASE64_CANONICAL S
LOCK_BASE64_FORM S
LOCK_BASE64_SIZE S
LOCK_BASE64_CANONICAL S
HISTORICAL_PREFIX_BASE64_FORM S
HISTORICAL_PREFIX_BASE64_SIZE S
HISTORICAL_PREFIX_BASE64_CANONICAL S
CANONICAL_ROWS_ABSENT S
CANONICAL_TAB_ABSENT S
CURRENT_CANONICAL_UNAVAILABLE S
STALE_LOCK_LITERAL_MISMATCH S
PREDICATE_UNREGISTERED_EXCEPTION E
~~~

~~~text
PROCESS_EXECARGV_CONTROL S
CURRENT_CANONICAL S
ORDER_CONTROL S
SEPARATOR_CONTROL S
TERMINAL_CONTROL S
MALFORMED_ROUTING_CONTROL S
CONFIG_LIVE_IDENTITY S
CONFIG_TUPLE_SYNTAX S
LOCK_LIVE_IDENTITY S
LOCK_TUPLE_SYNTAX S
LIVE_GATE S
INERT_CONTROL S
BYPASS_CONTROL S
OVERFIRE_CONTROL S
DIRECT_ROUTE_CONTROL S
WRONG_NONCE_CONTROL S
HISTORICAL_POSITIVE S
HISTORICAL_FALSE_CLAIM S
HISTORICAL_TUPLE S
SUBSTITUTION_CONTROL S

CONFIG_INVERSE_RED F
STALE_LOCK_INVERSE_RED F

PREDICATE_SELECTED_REASONS S
PREDICATE_SELECTED_STATUS S
PREDICATE_SELECTED_EXIT S

STDOUT_CAP E
STDOUT_ERROR E
STDOUT_CLOSE_BEFORE_END E
STDOUT_INCOMPLETE E
STDERR_CAP E
STDERR_ERROR E
STDERR_CLOSE_BEFORE_END E
STDERR_INCOMPLETE E
STDOUT_SUMMARY_MISMATCH S
STDERR_UNEXPECTED S

WORKER_TIMEOUT E
WORKER_ERROR E
WORKER_EXIT_MISSING E
WORKER_EXIT_CODE E
TERMINATE_CALL E
TERMINATE_REJECTED E
TERMINATE_TIMEOUT E
WORKER_REAP_INCOMPLETE E
STDOUT_DESTROY E
STDERR_DESTROY E
STREAM_DRAIN_TIMEOUT E
LATE_EVENT_MUTATION S

SNAPSHOT_INCOMPLETE E
RECORDER_RESULT_SERIALIZE E
RECORDER_RESULT_CAP E
RECORDER_FALLBACK_SERIALIZE E
RECORDER_FALLBACK_CAP E
RECORDER_STDOUT_SYNC E
RECORDER_STDOUT_CALLBACK E
UNREGISTERED_REASON S

CHILD_STDIN_WRITE E
CHILD_STDIN_UNSETTLED E
CHILD_STDOUT_CAP E
CHILD_STDERR_CAP E
CHILD_PIPE_IO E
CHILD_TIMEOUT E
CHILD_TERMINATE E
CHILD_REAP E
CHILD_DRAIN E
CHILD_RESULT_ABSENT E
CHILD_RESULT_MULTIPLE S
CHILD_RESULT_PROTOCOL S
CHILD_STDERR_UNEXPECTED S
CHILD_POST_RESULT_ERROR E
CHILD_EXIT_MISMATCH S
~~~

Every component maintains a closed boolean map keyed by this vocabulary. At terminal snapshot,
reasons is exactly GLOBAL_REASON_ORDER.filter(key => facts[key] === true). Deduplication therefore
exists by construction. A reason producer may set only a registered key; an unknown key, thrown
string, child stderr token, JSON value, path, or attacker-controlled text sets only
UNREGISTERED_REASON/STRUCTURAL and is never copied into reasons.

The total fold is exact:

1. Severity is PASS/0 < FAIL/1 < ERROR/2 < STRUCTURAL/3.
2. Each true fact receives only its fixed classification above. Final status is the maximum
   classification and exit is the matching 0/1/2/3.
3. A FAIL fact is set only from a complete recursively valid registered product measurement.
   Retain each valid FAIL fact even if a later operational error raises final status to ERROR or
   a later structural fault raises it to STRUCTURAL.
4. Predicate-selected reasons/status/exit, request protocol copies, recorder result status/exit,
   and child result status/exit are never authority. Re-derive facts, status, and exit first, then
   compare.
5. MESSAGE_ABSENT is ERROR; MESSAGE_MULTIPLE is STRUCTURAL. Path scope/topology/alias/identity and
   schema/cardinality/protocol faults are STRUCTURAL. Syscall/open/read/close/pipe/deadline/reap/
   drain/publication failures are ERROR.
6. One otherwise-valid recorder result plus observed child exit 2 is
   CHILD_POST_RESULT_ERROR/ERROR. Other unexplained result/exit disagreement is
   CHILD_EXIT_MISMATCH/STRUCTURAL.
7. A result-cap fallback adds RECORDER_RESULT_CAP but preserves the maximum already-derived
   severity and every retained product red. It never forces ERROR over an existing STRUCTURAL and
   never erases FAIL facts.
8. A causally unstarted phase records unavailable/not_attempted_due_to and adds no missing
   Worker/message/stream/child/topology cascade fact. R4 rejection cannot also claim absent
   recorder/message/Worker output; request rejection cannot also claim absent Worker/message
   output.

Recorder and adapter each embed this same order and classification map as immutable constants.
The source-freeze extracts and hashes each literal serialization and proves byte equality. The
request carries only a checked copy. The launcher owns no alternate global reason vocabulary and
only max-folds its independently observed adapter/evidence facts under the same four-level status
order.

## 51. Non-self-referential V5 source-freeze and literal request instantiation

The future V5 source-freeze is one append-only strict UTF-8/LF Markdown file at the exact path in
section 43. It has no BOM, no CR, and one terminal LF. It is constructed in two immutable phases
to register final source and request identities without a hash cycle.

Phase A contains, in exact tables and literal Base64/fenced bytes where applicable:

1. this final V5 record full tuple and its V1/V2/V3/V4 prefix tuples;
2. S3, B3, predicate V3, recorder V5, new R4-V5, adapter, and launcher full
   path/bytes/SHA/LF/CR/BOM/terminal-LF tuples and exact allowed-import scans;
3. the recorder's literal predicate/runtime/environment/reason constants, R4-V5's literal
   recorder registration, the adapter's literal R4-V5 registration, and independent equality
   crosschecks for the complete predicate -> recorder -> R4-V5 -> adapter -> launcher chain;
4. the exact R4-V5 source/header/frame bytes and hashes, all canonical/biting frame fixtures,
   physical-EOF contract, maximum-frame arithmetic, and the exact Windows child command
   serialization with both non-NUL and NUL-inclusive UTF-16 unit counts;
5. the exact recursive request/result/message/fallback/lifecycle/event/stream schemas, global
   reason order and classes, status/exit fold, caps, deadlines, cwd, empty environment and
   environment hash;
6. the exact 44-entry topology buffer/hash/counts, manifest/receipt ownership, V5 evidence leaf,
   and create-new/noncircular rules;
7. the exact one-buffer input/vendor/embedded-manifest/metadata-registry-set/first-party/toolchain
   census derivations and every final literal count/serialization byte count/hash, including the
   embedded-manifest delimiter bytes and offsets; and
8. all future source tuples and other identities that this record deliberately leaves unknown.

Phase A ends with exactly this unique marker line, including its LF:

~~~text
<!-- CESIUM_SUPPLY_INVERSE_V5_SOURCE_FREEZE_PHASE_A_END -->
~~~

The phase-A prefix is every file byte from offset zero through that marker's LF. After phase A is
closed, its exact byte count and SHA-256 are computed from one buffer. No byte in phase A contains
or reserves its own byte count/hash. The adapter source contains only the exact source-freeze path
and the exact marker bytes. It stable-reads the source-freeze once as inert data, requires exactly
one marker, takes that prefix subarray, and independently records its byte count/hash. It embeds
no expected source-freeze prefix or full-file hash.

Using the now-literal phase-A prefix tuple, the source-freeze author constructs the complete
canonical V5 request exactly once. authority.sourceFreeze is the source-freeze path plus that
phase-A prefix byte count/hash. All program/source/registry/manifest/topology identities are the
phase-A literals. Required future census serialization lengths remain exact null where section 45
registers null; they are never replaced by aggregate content bytes. The author freezes the
request's exact bytes including terminal LF, SHA-256, and canonical Base64.

Phase B begins on the byte immediately after the phase-A marker and begins with exactly:

~~~text
<!-- CESIUM_SUPPLY_INVERSE_V5_SOURCE_FREEZE_PHASE_B_BEGIN -->
~~~

It contains, in exact insertion order, the phase-A pathTuple, request bytes, request SHA-256,
request Base64, the complete instantiated recursive request value, and an independent
decode/parse/reserialize/rehash equality table. It also repeats only as checked values every final
R4-V5/frame/Win32/topology sentry from phase A. Phase B never changes a phase-A byte. The final
full source-freeze tuple is computed externally after Phase B and is not embedded in any covered
source, request, or in the source-freeze itself.

At execution, adapter stable-reads the already root-rehashed full source-freeze as inert data,
rederives the unique phase-A prefix, extracts the registered request Base64 through the exact
Phase-B schema, canonically decodes and validates it, requires its authority.sourceFreeze to equal
the observed prefix tuple, and writes exactly those request bytes create-new. No text from the
record is evaluated, imported, interpolated into R4-V5, used as a pathname code selector, or
accepted without the exact closed data schema. The recorder still treats every request field as a
duplicate claim and relies on its pre-request entry constants.

This sequence is mandatory. A source-freeze with one phase, a self-hash placeholder, an adapter
or recorder embedded source-freeze hash, a request hash in phase A, a second request
serialization, a source identity derived from request claims, or any V4 R4/frame/Win32/topology
sentry is STRUCTURAL and cannot release source or execution.

## 52. Required green controls and biting V5 mutants

The later source implementation and source-freeze must preregister exact bytes/expected facts for
all controls below. No control is authorized to execute by this append.

1. **Registration before request:** valid R4-V5/recorder bytes plus a request whose recorder claim
   is changed. Entry must validate from capsule constants first; recursive request validation must
   then reject REQUEST_RECORDER. A recorder that reads the request first or lets the request repair
   its registration is STRUCTURAL.
2. **R4 substitution:** replace exact R4-V5 in adapter execArgv with historical V4 R4 while leaving
   every other value unchanged. The adapter pin must reject before spawn. Independently change
   R4-V5's literal recorder byte count or hash and require R4_REGISTERED_SOURCE_BYTES or
   R4_REGISTERED_SOURCE_SHA256 before import.
3. **EOF ingress:** provide the exact registered frame in multiple chunks without EOF, EOF after
   the deadline, close-before-EOF, a second concatenated frame, a high-bit length byte, a high-bit
   hash byte, and one trailing zero. Each must map to its one registered R4 reason; no recorder
   import/request read may occur.
4. **Source-freeze cycle breaker:** bit-flip one byte before the unique phase-A marker, duplicate
   or delete the marker, alter only the phase-A tuple in Phase B, and alter only request Base64.
   Stable-read prefix and decode/reserialize checks must bite independently. No source-embedded
   hash or V4 sentry may rescue the mutant.
5. **Recursive request schema:** for every top block, mutate one nested key by omission,
   insertion, reordering, accessor/inherited substitution, wrong array cardinality, wrong
   primitive type, false/null/zero truthiness substitution, noncanonical Base64/hash/number, and
   over-cap byte. Each maps to the registered REQUEST_* block reason without starting a Worker.
6. **One-buffer derivations:** supply the correct aggregate vendor byte count as vendor census
   expectedBytes, use a second-read embedded manifest, reorder two registry-set TSV rows, alter a
   delimiter offset, and reuse the V4 topology digest. Each must be rejected; no guessed identity
   or aggregate-for-serialization substitution is accepted.
7. **Reason order/classes:** set facts in reverse/event order, set the same fact twice, attempt an
   unregistered attacker string, and swap one ERROR/STRUCTURAL class. Output must remain the exact
   global filter order, deduplicated; attacker text becomes only UNREGISTERED_REASON and a class
   swap is STRUCTURAL.
8. **Predicate/product split:** construct a complete valid config-only red, stale-lock-only red,
   both-red, and one structural-control fault plus a product red. Predicate reasons comparison
   must omit both product codes while derived status/final outer facts retain them in config then
   stale-lock order. A structural fault dominates status without erasing a retained valid red.
9. **Worker exit/message:** exercise matching independently derived exits 0,1,2,3; one mismatching
   exit; no message; and two messages. Matching exits are valid, mismatch bites, absence is ERROR,
   and multiplicity is STRUCTURAL.
10. **Extent-aware streams:** cross each cap in the middle of one chunk and prove retained prefix,
    observed full-chunk extent/hash, cap flags, cancellation, destroy, and incomplete drain. Inject
    error-before-close, close-before-end, and late post-seal data; none may be reported complete or
    mutate the frozen result.
11. **Lifecycle:** withhold physical Worker exit after terminate resolves, reject terminate,
    resolve terminate after snapshot, withhold one stream close, and fill the event log through
    its reserved slot. Reap requires exit, errors do not settle streams, late continuations cannot
    mutate, and SNAPSHOT_BEGIN remains final.
12. **Separate outer windows:** allow a recorder/adapter child to outlive the 3,000-ms graceful
    window, then exercise the 2,000-ms force window and 3,000-ms drain. The observation must retain
    both stages; progress cannot reset a deadline and force cannot be reported as graceful.
13. **Fallback severity:** overfill a full result while a STRUCTURAL fact and a valid product red
    are already present. Fallback must add RECORDER_RESULT_CAP, retain both facts, and remain
    STRUCTURAL. Repeat from PASS and require ERROR, then force fallback serialization/cap failure
    and require no authoritative result.
14. **Child result/exit:** emit exactly one otherwise-valid result then exit 2, and separately emit
    one result with an unexplained nonmatching exit. The first is CHILD_POST_RESULT_ERROR/ERROR;
    the second is CHILD_EXIT_MISMATCH/STRUCTURAL. Zero and multiple complete results bite their
    separately registered reasons.
15. **Causal suppression:** reject at R4, recorder entry, and request phases separately. Each
    result/outer observation records unavailable/not_attempted_due_to for later phases and does
    not add absent Worker/message/stream/topology cascade reasons.

Every measured red, malformed artifact, cap fallback, partial stream, timeout, ERROR, and
STRUCTURAL output is retained. A control that does not bite is STRUCTURAL; it is never omitted,
rerun away, demoted, or quarantined.

## 53. V5 review, source-freeze, and continuing release hold

After this suffix is complete, the author freezes and reports the complete-file tuple, the exact
126,391-byte V4 prefix tuple, and the exact V5 suffix tuple with bytes/SHA/LF/CR/BOM/terminal-LF.
Any V4-prefix mismatch voids V5.

Two fresh independent nonauthor reviews are mandatory over those exact physical bytes:

1. a recursive-schema/reason-fold reviewer must reconstruct every request, message, predicate,
   recorder, fallback, event, stream, child, cap, classification, and selected-versus-derived
   rule and return unconditional GO or exact NO-GO findings; and
2. a registration/lifecycle/source-freeze reviewer must reconstruct the one-way
   recorder/R4-V5/adapter chain, pre-request gate, environment, deadlines, cancellation/reap/
   drain/late-immutability rules, two-phase cycle break, one-buffer derivations, topology,
   negative controls, and release order and return unconditional GO or exact NO-GO findings.

Neither this author/coordinator nor either V5 mapping adviser may review. Conditional GO, partial
review, review of a summary, missing byte/hash cardinality, or an unresolved finding is NO-GO.
Even two record GOs authorize only a separately root-dispatched source-authoring lane; they do not
authorize source creation here.

If root later grants source authority, dependency order is predicate rehash -> recorder V5 freeze
-> literal R4-V5 instantiation/freeze -> adapter freeze -> launcher freeze -> source-freeze phase
A -> request instantiation -> source-freeze phase B. Each source receives independent security
and lifecycle/evidence review. Root then terminally rehashes this V5 record, the complete
source-freeze and its phase-A prefix, every source/bootstrap/frame/request/input/vendor/metadata/
toolchain/census identity, the exact empty environment, and the V5 leaf-absence boundary. Any
mismatch or pre-existing leaf is NO-GO.

Only a separately explicit one-shot execution authorization may then release exact S3 once.
Every resulting PASS, FAIL, ERROR, STRUCTURAL, malformed, partial, or fallback artifact remains in
the V5 leaf. A fresh physical evidence reviewer who was neither record author/reviewer, source
author/reviewer, nor executor must reconstruct the entire nested observation from physical bytes.

The supply-chain/Cargo gate remains categorically NO-GO through this V5 append, both record
reviews, source authoring, source review, source-freeze, and any later one-shot run. It can advance
only after complete retained physical evidence receives fresh unconditional independent GO.
This append grants no source, launcher, adapter, predicate, recorder, package, lock, vendor,
evidence, Node, Cargo, rustc, rustup, build, test, product, Q-152, browser, network,
documentation, Git, commit, push, or execution authority.

## 54. Exact primitive-to-reason predicates

All fact booleans begin false. A fact is set if and only if its condition below is observed in a
phase that actually started. Validators are fail-closed in listed order within a block; after a
blocking condition, later dependent predicates are unstarted rather than inferred. The fixed
classification in section 50 then supplies status/exit.

### 54.1 R4 and recorder entry

| Fact | Exact setting condition |
| --- | --- |
| R4_ARGV | process.argv is not exactly [process.execPath] |
| R4_EXECARGV | process.execArgv is not the exact five-item V5 eval vector with self-equal item four |
| R4_STDIN_TOPOLOGY | stdin is absent, not the sole piped readable ingress, already flowing/consumed, or has an extra registered reader |
| R4_FRAME_SIZE | total observed frame bytes are zero or exceed recorderFrameBytes |
| R4_MAGIC | the initial bytes are not the exact V5 magic plus LF |
| R4_HEADER | either required header LF is absent/out of place or header field cardinality is not exact |
| R4_LENGTH_EMPTY | the declared-length field contains zero bytes |
| R4_LENGTH_LEADING_ZERO | declared length has more than one byte and begins with ASCII zero |
| R4_LENGTH_BYTE | a declared-length byte is outside ASCII 0..9 |
| R4_BYTE_LENGTH | parsed length is unsafe, negative, or exceeds recorderSourceBytes |
| R4_HASH_LENGTH | source-hash field is not exactly 64 bytes |
| R4_HASH_BYTE | a source-hash byte is not lowercase ASCII hex |
| R4_SOURCE_LENGTH | EOF arrives before the declared number of source bytes |
| R4_TRAILING_DATA | any byte exists after the exact declared source extent |
| R4_BOM | decoded source begins UTF-8 BOM |
| R4_CR | source contains 0x0d |
| R4_TERMINAL_LF | source is empty or does not end in exactly one 0x0a |
| R4_UTF8 | the source extent is not strict UTF-8 |
| R4_HASH | hash of the exact source extent differs from the header hash |
| R4_HEADER_RESERIALIZE | exact magic/decimal-length/hash/LF reserialization differs from observed header |
| R4_REGISTERED_SOURCE_BYTES | declared/observed source length differs from R4-V5's literal recorder byte count |
| R4_REGISTERED_SOURCE_SHA256 | observed source hash differs from R4-V5's literal recorder hash |
| R4_EOF_REQUIRED | a complete candidate frame is present but physical EOF was not observed |
| R4_CAPSULE | the one immutable capsule cannot be created with the exact descriptor/key/value schema |
| R4_INGRESS_TIMEOUT | physical EOF and complete validation do not finish by the absolute ingress deadline |
| R4_STDIN_CHUNK_TYPE | an ingress chunk is not Buffer/Uint8Array bytes |
| R4_STDIN_ERROR | stdin emits error before accepted EOF |
| R4_STDIN_ABORTED | stdin is destroyed/aborted before accepted EOF |
| R4_STDIN_CLOSE_BEFORE_EOF | close is observed without prior end/EOF |
| R4_STDIN_CLEANUP | ingress listeners/state cannot be detached/sealed after adjudication |
| R4_IMPORT | the sole registered data-URL import rejects or throws |
| R4_REPORT_IO | bounded R4 diagnostic/exit publication itself throws or fails |

Recorder entry facts are:

| Fact | Exact setting condition |
| --- | --- |
| ENTRY_ARGV | recorder process.argv is not exactly [process.execPath] |
| ENTRY_EXECARGV_SHAPE | the five execArgv strings/order/types, flags, or strict item-four text shape differ |
| ENTRY_RUNTIME | Node path/bytes/hash/version/platform/arch differs from recorder constants |
| ENTRY_CWD | lexical/resolved cwd differs from the recorder constant |
| ENTRY_ENVIRONMENT | process.env is not the exact empty plain map or its canonical hash differs |
| ENTRY_CAPSULE_DESCRIPTOR | capsule missing/extra, wrong global descriptor, writable/configurable/enumerable, or mutable |
| ENTRY_CAPSULE_KEYS | capsule own insertion-order keys differ |
| ENTRY_REGISTRATION_SCHEMA | registrationSchema differs from CESIUM_SUPPLY_INVERSE_RECORDER_REGISTRATION_V5 |
| ENTRY_SOURCE_BASE64_FORM | sourceBase64 is empty, wrong type, bad padding/alphabet/cardinality |
| ENTRY_SOURCE_BASE64_SIZE | encoded or decoded source exceeds recorderSourceBytes |
| ENTRY_SOURCE_BASE64_CANONICAL | decode/re-encode differs |
| ENTRY_SOURCE_TEXT | decoded source violates strict UTF-8/no-BOM/no-CR/exact-terminal-LF |
| ENTRY_SOURCE_BYTES | capsule sourceBytes differs from decoded bytes or observed item-four UTF-8 bytes |
| ENTRY_SOURCE_SHA256 | capsule sourceSha256 differs from the decoded/observed source hash |
| ENTRY_HEADER_REBUILD | rebuilt V5 header tuple differs from capsule header bytes/hash |
| ENTRY_FRAME_REBUILD | rebuilt header+source differs from capsule frame bytes/hash |
| ENTRY_EOF | eofObserved is not exactly true |
| ENTRY_SOURCE_REGISTRATION | observed source tuple differs from registeredSourceBytes/registeredSourceSha256 |

### 54.2 Stable reads and request blocks

For REQUEST_* and PREDICATE_* stable-read pairs, SCOPE means the registered lexical path is
outside its registered root; ESCAPE means resolved realPath leaves that root;
ALIAS_OR_REPARSE means a symlink/reparse/alias or dev+ino collision is observed;
NONREGULAR_OR_LINK means not a single regular nlink=1 file; SIZE means zero/over-cap/pre-open size
invalid; OPEN_IO, READ_IO, and CLOSE_IO mean their named syscall fails; IDENTITY means dev/ino
changes; SHORT_READ means received extent is below the pre-open size; GREW means it exceeds that
size; UNSTABLE means any nlink/mode/size/identity changes between open and close. REQUEST_TEXT and
PREDICATE_TEXT mean strict text-form failure. REQUEST_JSON means JSON parse failure;
REQUEST_CANONICAL means byte-for-byte JSON reserialization failure; REQUEST_KEYS means top-level
plain-object/key-order failure. PREDICATE_REGISTRATION means stable predicate bytes/hash differ
from recorder constants.

After request bytes are canonical, each request block fact is set iff any primitive, nested key
order/type/cardinality, enum, bound, tuple, hash, Base64, derivation, or cross-equality in that
exact top-level block fails:

~~~text
authority -> REQUEST_AUTHORITY
bootstraps -> REQUEST_BOOTSTRAPS
censuses -> REQUEST_CENSUSES
claimLimits -> REQUEST_CLAIM_LIMITS
cwd -> REQUEST_CWD
deadlines -> REQUEST_DEADLINES
environment -> REQUEST_ENVIRONMENT
evidence -> REQUEST_EVIDENCE
inputs -> REQUEST_INPUTS
limits -> REQUEST_LIMITS
metadata -> REQUEST_METADATA
nonce -> REQUEST_NONCE
predicate -> REQUEST_PREDICATE
protocol -> REQUEST_PROTOCOL
recorder -> REQUEST_RECORDER
recorderRegistration -> REQUEST_RECORDER_REGISTRATION
registrations -> REQUEST_REGISTRATIONS
runtime -> REQUEST_RUNTIME
schema -> REQUEST_SCHEMA
sources -> REQUEST_SOURCES
toolchain -> REQUEST_TOOLCHAIN
topology -> REQUEST_TOPOLOGY
vendor -> REQUEST_VENDOR
version -> REQUEST_VERSION
~~~

### 54.3 Worker, message, and predicate facts

| Fact family | Exact setting condition |
| --- | --- |
| WORKER_CONSTRUCT | registered Worker construction throws/rejects |
| WORKER_HANDLER_ATTACH | every required handler is not attached before the first await |
| WORKER_EVENT_CAP | a pre-snapshot event would consume reserved slot 63 or exceed eventCount |
| MESSAGE_ABSENT / MESSAGE_MULTIPLE | accepted-message cardinality at snapshot is zero / greater than one |
| MESSAGE_KEYS | message is not a plain exact jsonBase64,jsonSha256 object |
| MESSAGE_BASE64_FORM / SIZE / CANONICAL | wrong Base64 primitive/form / encoded-or-decoded cap / re-encode mismatch |
| MESSAGE_HASH | decoded message hash differs from jsonSha256 |
| MESSAGE_TEXT / JSON / CANONICAL | decoded bytes violate text form / parse / exact reserialization |
| PREDICATE_RESULT_KEYS | top or any registered nested key order/cardinality differs |
| PREDICATE_RESULT_SCHEMA | schema differs from CESIUM_SUPPLY_INVERSE_PREDICATE_V3 |
| PREDICATE_RESULT_NONCE | projected nonce differs from request rules |
| PREDICATE_RESULT_VALIDATOR | validatorId or validator primitive schema/identity differs |
| PREDICATE_RESULT_REASONS | selected reasons primitive/order/allowlist shape is invalid |
| PREDICATE_RESULT_CONTROLS | complete/exception controls nullability or any controls primitive is invalid |
| PREDICATE_RESULT_INVERSES | complete/exception inverses nullability or any inverse primitive is invalid |

Each controlled predicate exception code from PARENT_PORT_ABSENT through
STALE_LOCK_LITERAL_MISMATCH is set iff controls===null, inverses===null, and the one selected
exception string is exactly that registered code with schema/nonce/validator/status/exit shape
otherwise valid. Any other thrown/selected exception string sets only
PREDICATE_UNREGISTERED_EXCEPTION.

Each predicate-control fact from PROCESS_EXECARGV_CONTROL through SUBSTITUTION_CONTROL is set iff
the corresponding exact independently validated control in section 47 is not green. No selected
boolean alone can clear it. CONFIG_INVERSE_RED is set iff the complete config inverse has its
registered live/mutation/mutant/tuple/nonvacuity/sole-mismatch/callback primitives and still
accepts, permits launch, calls back, or otherwise violates the registered inverse rejection.
STALE_LOCK_INVERSE_RED is identical for the registered three-removal stale-lock inverse. The two
product facts are never set from an incomplete or structurally invalid measurement.

PREDICATE_SELECTED_REASONS is set iff selected reasons differ byte-for-byte from the independently
derived predicate structural array. PREDICATE_SELECTED_STATUS is set iff selected status differs
from the independently derived predicate status. PREDICATE_SELECTED_EXIT is set iff selected exit
or an observed valid Worker exit code 0..3 differs from the independently derived predicate exit.
WORKER_EXIT_CODE is reserved for an abnormal/noninteger/out-of-range runtime exit observation that
prevents that valid-code comparison.

### 54.4 Streams, lifecycle, finalization, and child facts

For each Worker stream, *_CAP is set exactly when observedBytes>capBytes; *_ERROR when its error
event occurs; *_CLOSE_BEFORE_END when close occurs without earlier end; and *_INCOMPLETE when the
healthy-complete predicate in section 49 is false at snapshot. STDOUT_SUMMARY_MISMATCH is set iff
the one retained stdout line is not the exact derived summary. STDERR_UNEXPECTED is set iff
observed stderr extent is nonzero after an otherwise complete capture.

| Fact | Exact setting condition |
| --- | --- |
| WORKER_TIMEOUT | physical Worker exit/final valid observation misses the absolute worker deadline |
| WORKER_ERROR | Worker error event occurs |
| WORKER_EXIT_MISSING | no physical Worker exit is observed by reap adjudication |
| WORKER_EXIT_CODE | physical exit is observed but its code is noninteger, outside 0..3, or abnormal so a valid-code comparison is impossible |
| TERMINATE_CALL | Worker.terminate invocation throws synchronously |
| TERMINATE_REJECTED | terminate promise rejects |
| TERMINATE_TIMEOUT | requested terminate promise remains unsettled at reap deadline |
| WORKER_REAP_INCOMPLETE | physical Worker exit is absent after the reap window |
| STDOUT_DESTROY / STDERR_DESTROY | the named destroy call throws/fails or the stream remains open after its required destroy |
| STREAM_DRAIN_TIMEOUT | either stream lacks physical close at drain deadline |
| LATE_EVENT_MUTATION | any accepted field/event/reason/capture/canonical byte changes after SNAPSHOT_BEGIN closure |
| SNAPSHOT_INCOMPLETE | any required started-phase field, seal, final event, or immutable copy is incomplete |
| RECORDER_RESULT_SERIALIZE | full result cannot be canonically serialized/measured |
| RECORDER_RESULT_CAP | canonical full candidate including LF exceeds recorderResultBytes |
| RECORDER_FALLBACK_SERIALIZE | cap fallback cannot be canonically serialized/measured |
| RECORDER_FALLBACK_CAP | canonical fallback including LF exceeds recorderResultBytes |
| RECORDER_STDOUT_SYNC | the sole stdout write throws synchronously |
| RECORDER_STDOUT_CALLBACK | its callback reports failure or never completes before publication adjudication |
| UNREGISTERED_REASON | any attempted fact/reason is outside the closed vocabulary |

For adapter/launcher child observation:

| Fact | Exact setting condition |
| --- | --- |
| CHILD_STDIN_WRITE | sole frame write/end invocation or callback fails |
| CHILD_STDIN_UNSETTLED | write/end settlement is incomplete at the child boundary |
| CHILD_STDOUT_CAP / CHILD_STDERR_CAP | named observed extent exceeds its cap |
| CHILD_PIPE_IO | any child pipe emits an I/O error not represented by the more specific stdin fact |
| CHILD_TIMEOUT | physical child exit misses its absolute deadline |
| CHILD_TERMINATE | graceful or force terminate call throws/fails |
| CHILD_REAP | physical child exit is absent after both registered reap windows |
| CHILD_DRAIN | either child pipe lacks physical close at drain adjudication |
| CHILD_RESULT_ABSENT | zero complete canonical result/summary lines after complete drain |
| CHILD_RESULT_MULTIPLE | more than one complete canonical result/summary line |
| CHILD_RESULT_PROTOCOL | the sole line fails exact full/fallback/adapter-summary recursive validation |
| CHILD_STDERR_UNEXPECTED | complete child stderr observedBytes is nonzero without a registered pipe error |
| CHILD_POST_RESULT_ERROR | exactly one otherwise-valid result exists and physical child exit is exactly 2 |
| CHILD_EXIT_MISMATCH | any other trustworthy result-derived exit and physical child exit disagree |

These predicates are exhaustive with section 50's order and classes. A started primitive failure
that fits no registered predicate sets UNREGISTERED_REASON; a causally unstarted primitive sets
nothing and is recorded only as unavailable/not_attempted_due_to.

## 55. Terminal V5 record state

This complete suffix remains an author candidate requiring the two fresh nonauthor reviews in
section 53. The supply-chain/Cargo gate and every source, execution, evidence, and release action
remain categorical NO-GO. Section 54 adds only explicit mapping detail and grants no authority.
