# Rust process-supervisor offline Cargo.lock refresh preregistration

- Status: **LOCK REFRESH COMPLETE / METADATA GREEN / INDEPENDENT SUPPLY-CHAIN REVIEW PENDING**
- Owner: root orchestrator
- Purpose: refresh one stale local workspace lockfile without changing the registry closure

This is an internal recovery record, not product documentation, build evidence, runtime evidence,
security certification, or a platform-support claim. The supply-chain tuple remains NO-GO until the
refreshed lock, frozen/offline resolver metadata, vendor tree, and record receive a new independent
review.

## Exact writable boundary

The only repository source path that this recovery may change is:

- `Tools/process-supervisor/Cargo.lock`

This preregistration record is the only governance path added by the recovery. Disposable scratch,
Cargo-home, target, and process-temp directories may be created outside the repository and retained
for review. Every manifest, `.cargo/config.toml`, `rust-toolchain.toml`, vendored source, Rust
source, test, README/design/security/test-plan/supply-chain record, JavaScript package file, campaign
queue, and unrelated dirty path is read-only. No Git write, network access, package install, build,
test, browser, Edge, publication, VM action, or certification action is authorized by this record.

## Frozen resolver inputs

The scratch trial and live refresh must start from this exact tuple:

| Input | Bytes | SHA-256 |
| --- | ---: | --- |
| `Cargo.toml` | 992 | `179c592964901b2abcbd432f904f92f546e16d14b8fd335fb4b9d51048f26e2d` |
| `Cargo.lock` | 6,575 | `f786d3ec5ae18179b94b2710d9a565c33843e9db4546a65e28488c3f50822023` |
| `rust-toolchain.toml` | 87 | `6152f0907eaac1d9806d46246c4c9715bfdb7eaa400323a34b9f493ff0e6f946` |
| `.cargo/config.toml` | 123 | `992df442f8e3a3e2188c6088a75abaf7a6311926e02e1392d4090b1a5b27fd62` |
| `crates/proc-supervisor-cli/Cargo.toml` | 470 | `68c7c8a92251be922230ce67d339ce76affb7f3f2237dbbb3961604d905ccd03` |
| `crates/q152-process-runner/Cargo.toml` | 454 | `3b15ee3ad1fbad1711f7c549f76b05ca470b0f627c18d9c12f652d7adb1da1f0` |
| `crates/supervisor-core/Cargo.toml` | 235 | `f967857f7d167d59668ed53e8321c953be0a25f99aed0651ad8e6c5ce268f09c` |
| `crates/supervisor-native/Cargo.toml` | 406 | `b286343a1f489c3110feb86847f9595c9ddeeec5937293a5851dc9dc9e924c73` |
| `crates/supervisor-protocol/Cargo.toml` | 362 | `63ca376b15e0183fc0e56a50938ae95f097aaea6fdc57af7af086b1066769c5f` |
| `crates/supervisor-test-child/Cargo.toml` | 259 | `25b42df907e3a4a331e2fd2d7dfef520c74e103493646a7bb2a97940d4f7ff86` |
| `tests/Cargo.toml` | 488 | `0aee198b9a84f4ccb75227bb9bbf87d520d7caf8f092a36a454dae6f97a67b82` |
| `SUPPLY_CHAIN.md` | 184,665 | `49d84f2b35f27c063c8c69dceae91ad29ba41162216cc9efa2ffe7f8ed449486` |

The complete bank tuple is 1,385 files / 30,608,359 bytes / aggregate SHA-256
`e50a4ea2e85b120d46514bae0aee6c163b8338f3ee87cda6dad769165c67b426`. The vendored
source boundary is 1,383 files / 30,423,571 bytes with canonical manifest SHA-256
`ca954a20ea857cc4e43e965d505671d56bcd9184095309311b66482d036f1f05`.

The named toolchain executables are:

| Executable | Bytes | SHA-256 |
| --- | ---: | --- |
| `C:\Users\Kurt\.rustup\toolchains\1.94.0-x86_64-pc-windows-msvc\bin\cargo.exe` | 30,754,304 | `cbfdfc04b61ba49d184c6d3996502a00391d570cb5cb71a00faeb8c0ce12a4c9` |
| `C:\Users\Kurt\.rustup\toolchains\1.94.0-x86_64-pc-windows-msvc\bin\rustc.exe` | 111,104 | `6a0699e427ee9c1492ef1c9ea967d035dc4660e92c7fe32f2c6a1038116700e5` |

The required versions are Cargo `1.94.0 (85eff7c80 2026-01-15)` and rustc
`1.94.0 (4a4ef493e 2026-03-02)` for `x86_64-pc-windows-msvc`. A mutable `stable` alias
is not an acceptable executable identity.

## Preregistered recovery protocol

1. Rehash every frozen input and the complete vendor manifest before execution. Hash drift stops.
2. Copy only resolver inputs, member workspaces, `.cargo/config.toml`, and the vendor tree to a
   fresh disposable directory; do not copy `target/` or documentation.
3. Create fresh empty Cargo-home and process-temp directories. Invoke the absolute pinned Cargo with
   argv `generate-lockfile --offline` from the scratch workspace. Set
   `CARGO_NET_OFFLINE=true`, `CARGO_TERM_COLOR=never`, the pinned toolchain directory as the
   only `PATH`, the pinned absolute `RUSTC`, and the fresh `CARGO_HOME`, `TEMP`, and
   `TMP` values.
4. Retain the scratch lock and command result. Compare it byte-for-byte with the frozen lock.
5. The only acceptable semantic delta is adding `sha2` to the local `proc-supervisor-cli`
   dependency array and adding `sha2` plus `windows-sys` to the local
   `process-supervisor-tests` dependency array. No registry package, version, source, checksum,
   package count, or other local dependency array may change.
6. If and only if the scratch delta matches, apply that exact minimal textual delta to the live lock
   with the patch tool. Rehash all read-only inputs and prove no other repository path changed in this
   recovery lane.
7. In a second fresh empty Cargo home, run the absolute pinned Cargo with argv
   `metadata --frozen --offline --format-version 1` from the live workspace under the same
   controlled environment. Retain the exit status and raw output identities. Exit zero is required.
8. Recompute the registry closure from metadata and require the same 25 vendored packages. Re-run the
   exhaustive archive/vendor/config checks and inverse control before requesting independent review.

## Acceptance and stop conditions

The recovery passes only when all frozen preimages match, the scratch command exits zero, the lock
delta is exactly the three predicted local edges, live frozen/offline metadata exits zero, the
registry closure and vendor bytes remain unchanged, all process children are reaped, and a fresh
independent reviewer returns unconditional GO over the superseding tuple.

Any unexpected lock delta, resolver/network attempt, nonempty initial Cargo home, toolchain drift,
manifest/config/vendor drift, residual child, missing raw result, metadata failure, closure change,
or conditional review is a terminal NO-GO. A successful lock refresh releases only later local
diagnostic planning; it does not certify the Rust tool or authorize its build and test matrix.

## Root execution record

The frozen pre-run audit matched all twelve listed files with zero mismatches. The vendor rehash
matched 1,383 files / 30,423,571 bytes / canonical SHA-256
`ca954a20ea857cc4e43e965d505671d56bcd9184095309311b66482d036f1f05`.

The retained scratch workspace is:

`C:\Users\Kurt\AppData\Local\Temp\codex-rust-lock-refresh-3032560b0f4644a7b2060d135b117e6f`

Pinned Cargo PID 17304 ran `generate-lockfile --offline` and exited zero within the bound.
Its initially empty Cargo home ended with only `.global-cache` and `.package-cache`. Raw stdout
is 0 bytes / SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Raw stderr is
55 bytes / SHA-256
`3743a94507e8cc5b09427f9fe1657b29fc15d16e834dd4636f8a232f6060661f`; it reports
that Cargo locked 25 packages to compatible versions.

The scratch lock is 6,609 bytes / SHA-256
`681d72ab1726a739f5e9240ab1a9eca9a91e4bcfcab5456464cec8f5889a4a83`. Its complete
delta from the frozen preimage is exactly:

- add `sha2` to `proc-supervisor-cli`;
- add `sha2` to `process-supervisor-tests`; and
- add `windows-sys` to `process-supervisor-tests`.

No package block, version, source, checksum, or other dependency array changed. Root applied those
three lines with the patch engine. The live lock is byte-identical to the scratch result at 6,609
bytes / SHA-256
`681d72ab1726a739f5e9240ab1a9eca9a91e4bcfcab5456464cec8f5889a4a83`.

The retained live metadata run is:

`C:\Users\Kurt\AppData\Local\Temp\codex-rust-metadata-b16fd8a449b842639ea69b33c329c01d`

Pinned Cargo PID 5916 ran `metadata --frozen --offline --format-version 1` and exited zero.
Its initially empty Cargo home ended with only `.global-cache` and `.package-cache`; PID
5916 was absent after exit. Raw stdout is 123,501 bytes / SHA-256
`693093b689490c802805ccf2a8cbc36684a24afa53faa4a6204707d348ccfb4c`. Raw stderr is
0 bytes / the empty SHA-256 above. Parsed metadata contains 32 packages: the same 25 registry
packages plus seven local workspace packages and seven workspace members.

The post-run rehash again matched every frozen read-only input, substituting only the registered new
lock identity, and matched the complete vendor count, bytes, and canonical hash. No Cargo build,
Rust test, build script, proc macro, browser, server, network, install, Git write, publication, VM
action, or certification action occurred.

### Retained instrument errors

- Two early sandboxed patch-helper creation attempts failed before writing the preregistration file;
  the same patch engine was then invoked outside the failing sandbox.
- The first pre-run vendor-rehash orchestration script failed JavaScript parsing before command or
  process creation because a PowerShell tab escape ended its JavaScript template.
- The first post-run raw-artifact listing reached and completed the input/vendor rehash, then its
  `Join-Path` array construction failed before listing artifacts. The four existing raw files were
  subsequently hashed read-only at the identities above.

These instrument errors are not resolver evidence and are not hidden or promoted to green. The
refresh and metadata observations remain review-pending. No later Cargo command is released until
the exhaustive supply-chain recheck and fresh independent review complete.
