# Denethor independent review — Rust process-supervisor supply chain

**Date:** 2026-08-30  
**Role:** tier-2 independent supply-chain reviewer  
**Subject:** Tools/process-supervisor/SUPPLY_CHAIN.md  
**Verdict:** **NO-GO**

The frozen supply-chain record, live resolver inputs, refreshed lock, retained metadata
artifact, offline Cargo configuration, and complete vendor tree are internally consistent and
match their recorded identities. Both mutant byte streams and their canonical tuple digests are
also reproducible without changing a file.

The post-lock-refresh inverse-control result is nevertheless not independently reviewable after
the Codex reset. Its exact predicate stdout and outer JSON envelope were retained only under the
session key rust_supply_inverse_run_v1. That key now returns MISSING in both this child session
and the root session, and no physical copy exists in the searched repository evidence boundary.
Consequently this review cannot independently prove accepted=false, launch_permitted=false,
execution.launch_count=0, either per-mutant before/after launch canary, or the recorded predicate
stdout identity. The prose in SUPPLY_CHAIN.md is the only remaining source for those values.

Per the preregistered stop condition requiring inverse nonvacuity and rejected-before-launch
proof, the narrow supply-chain review remains **NO-GO**. This verdict does not invalidate the
independently reproduced source-closure facts below, and it does not authorize a rerun.

## 1. Authority and boundary

The review was authorized to:

- read and hash the frozen subject, Rust workspace manifests, lock, offline Cargo config,
  vendor tree, retained resolver artifact, and existing inverse artifacts;
- reconstruct the two recorded mutants only in memory;
- write only this review record; and
- request two fresh, read-only reviews after freezing this record.

The review was not authorized to run Cargo, rustc, rustup, Node, npm, tests, builds, product or
supervisor binaries, browser work, network work, process enumeration, evidence publication, or
any Git command. None occurred.

The subject matched its dispatch tuple on entry:

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| Tools/process-supervisor/SUPPLY_CHAIN.md | 195,674 | F7157F11B7E63E2228CF851B3B6EDEC30168817C9291EEE2F1AC9C27201BBCB2 |

The subject was read in full, including the complete 1,383-row embedded vendor manifest and the
post-lock-refresh inverse and transport-error appendices.

## 2. Resolver and input identities

The following physical files matched the identities recorded by the post-lock-refresh section:

| Logical path | Bytes | SHA-256 |
| --- | ---: | --- |
| Cargo.toml | 992 | 179c592964901b2abcbd432f904f92f546e16d14b8fd335fb4b9d51048f26e2d |
| Cargo.lock | 6,609 | 681d72ab1726a739f5e9240ab1a9eca9a91e4bcfcab5456464cec8f5889a4a83 |
| rust-toolchain.toml | 87 | 6152f0907eaac1d9806d46246c4c9715bfdb7eaa400323a34b9f493ff0e6f946 |
| .cargo/config.toml | 123 | 992df442f8e3a3e2188c6088a75abaf7a6311926e02e1392d4090b1a5b27fd62 |
| crates/proc-supervisor-cli/Cargo.toml | 470 | 68c7c8a92251be922230ce67d339ce76affb7f3f2237dbbb3961604d905ccd03 |
| crates/q152-process-runner/Cargo.toml | 454 | 3b15ee3ad1fbad1711f7c549f76b05ca470b0f627c18d9c12f652d7adb1da1f0 |
| crates/supervisor-core/Cargo.toml | 235 | f967857f7d167d59668ed53e8321c953be0a25f99aed0651ad8e6c5ce268f09c |
| crates/supervisor-native/Cargo.toml | 406 | b286343a1f489c3110feb86847f9595c9ddeeec5937293a5851dc9dc9e924c73 |
| crates/supervisor-protocol/Cargo.toml | 362 | 63ca376b15e0183fc0e56a50938ae95f097aaea6fdc57af7af086b1066769c5f |
| crates/supervisor-test-child/Cargo.toml | 259 | 25b42df907e3a4a331e2fd2d7dfef520c74e103493646a7bb2a97940d4f7ff86 |
| tests/Cargo.toml | 488 | 0aee198b9a84f4ccb75227bb9bbf87d520d7caf8f092a36a454dae6f97a67b82 |
| SUPPLY_CHAIN.md, predicate-time prefix | 184,665 | 49d84f2b35f27c063c8c69dceae91ad29ba41162216cc9efa2ffe7f8ed449486 |
| ../../migration_doc/RUST_PROCESS_SUPERVISOR_CARGO_LOCK_REFRESH_PREREGISTRATION_2026-08-30.md | 9,547 | 8bf0681b1373f9f5f3d06654ecff88bcdfa0abbe1e1cae0131f9da73dd056f24 |

Using lowercase SHA-256, decimal byte lengths, ordinal path ordering, UTF-8 without a BOM, and
one terminal LF per canonical record, these thirteen predicate-time records reproduce:

- 13 records;
- 1,312 canonical bytes; and
- SHA-256 c1abf90fc4f3eaea63c4fb3e3be8d219bd1028cc1e09f319bc7173061c81ca6f.

The current subject is deliberately longer because the inverse receipt and publication-error
history were appended after the predicate ran. The split is exact:

| Subject segment | Bytes | SHA-256 |
| --- | ---: | --- |
| Predicate-time prefix | 184,665 | 49d84f2b35f27c063c8c69dceae91ad29ba41162216cc9efa2ffe7f8ed449486 |
| Later append | 11,009 | 2042eeda33f986e57964927042dd808f0ee0053769f4ab88b441b3a082b865dc |
| Current complete record | 195,674 | f7157f11b7e63e2228cf851b3b6edec30168817c9291eee2f1ac9c27201bbcb2 |

Replacing the prefix identity with the current complete record identity produces a different
current physical thirteen-record digest,
a3ab97284316b0c09edc271ae440dc92db0f7956e7d44e4a22ebcae1d8c762a6.
That distinction is expected append history, not hidden input drift.

The complete current subject has 1,954 LF bytes, zero CR bytes, no UTF-8 BOM, and a terminal LF.

## 3. Vendor and resolver closure

Read-only hashing of every live file below Tools/process-supervisor/vendor reproduced:

| Boundary | Files | Bytes | Canonical SHA-256 |
| --- | ---: | ---: | --- |
| Live vendor tree | 1,383 | 30,423,571 | ca954a20ea857cc4e43e965d505671d56bcd9184095309311b66482d036f1f05 |
| Embedded complete vendor manifest | 1,383 | 156,710 canonical bytes | ca954a20ea857cc4e43e965d505671d56bcd9184095309311b66482d036f1f05 |

The embedded 1,383-record manifest is byte-identical to a fresh canonical manifest derived from
the live vendor tree.

The refreshed Cargo.lock contains 32 package blocks: seven local packages and 25 registry
packages. All 25 registry packages carry checksums, there are 25 top-level vendor package
directories, and the name/version directory set is identical between lock and vendor. The
refreshed local dependency arrays contain:

- proc-supervisor-cli: sha2, supervisor-core, supervisor-native, supervisor-protocol;
- process-supervisor-tests: sha2, supervisor-core, supervisor-native,
  supervisor-protocol, windows-sys.

The retained metadata artifact at
C:/Users/Kurt/AppData/Local/Temp/codex-rust-metadata-b16fd8a449b842639ea69b33c329c01d/metadata.stdout.json
still exists at 123,501 bytes / SHA-256
693093b689490c802805ccf2a8cbc36684a24afa53faa4a6204707d348ccfb4c.
Read-only JSON parsing yields 32 packages, 25 registry packages, and seven workspace members.
Its registry name/version set is identical to both the refreshed lock and live vendor directory
set.

The retained metadata bytes corroborate resolver closure at the prior run. This review did not
rerun the resolver and therefore does not claim a fresh Cargo exit, fresh environment capture, or
fresh compiler identity.

The live .cargo/config.toml is valid UTF-8 and exactly records crates-io replacement by the
relative vendor directory plus net.offline=true. Its path-resolution caveat remains operative:
Cargo must be invoked from the process-supervisor workspace or with that config explicitly loaded.

## 4. Reproduced inverse inputs

### Config byte-flip mutant

An in-memory clone of the current 123 config bytes was changed only at byte offset zero from
0x5b to 0x5a. It reproduced:

- mutant bytes: 123;
- mutant SHA-256:
  3d00279785e55a40d6e5f702d91810965b00a438bafc265fa3333d7f0a36d782; and
- complete thirteen-input mutant tuple SHA-256:
  31e296d0c3faa19094199aae094a038189ac43ba96d8e2749988500cb6008d42.

The physical config remained 123 bytes /
992df442f8e3a3e2188c6088a75abaf7a6311926e02e1392d4090b1a5b27fd62
after the read-only audit.

### Exact stale-lock reconstruction

Starting from the current 6,609 lock bytes, the review removed in descending-offset order:

| Original offset | Bytes | Exact LF-terminated literal |
| ---: | ---: | --- |
| 2,603 | 16 | space, quoted windows-sys, comma, LF |
| 2,528 | 9 | space, quoted sha2, comma, LF |
| 2,369 | 9 | space, quoted sha2, comma, LF |

All three physical slices matched before removal. The in-memory result reproduced:

- stale bytes: 6,575;
- stale SHA-256:
  f786d3ec5ae18179b94b2710d9a565c33843e9db4546a65e28488c3f50822023; and
- complete thirteen-input mutant tuple SHA-256:
  0dc0af2a59ef246d207881d7bfa3beeca6abe7dcf9ba76d37e8cc24eca1c30ae.

The physical lock remained 6,609 bytes /
681d72ab1726a739f5e9240ab1a9eca9a91e4bcfcab5456464cec8f5889a4a83
after the read-only audit.

These reconstructions prove that the recorded mutant identities are nontrivial and reproducible.
They do not prove what the lost predicate returned or whether anything launched.

## 5. Blocking inverse-evidence finding

SUPPLY_CHAIN.md identifies the predicate output through:

- predicate stdout: 15,859 bytes /
  a83a6b1ee5a8708b8269beaa408dead3a3896b5b5934bb23199c153cd2201c9f;
- outer combined output: 37,617 bytes /
  e60e25faf3a02e0416e51148da8e01b24e76aff6caa64ca05da4caa7490a7303;
- session key: rust_supply_inverse_run_v1.

The exact bytes behind those identities are unavailable:

1. loading rust_supply_inverse_run_v1 in this child session returned MISSING;
2. the root orchestrator independently loaded the same key after the reset and returned MISSING;
3. a repository search under Tools/process-supervisor and migration_doc, excluding the vendor
   payload, found those output identities and launch-count claims only in SUPPLY_CHAIN.md; and
4. the known retained Elendil inverse directory contains only the earlier 123-byte config copy,
   not the post-lock-refresh predicate source or result envelope.

Without the raw predicate source and structured result, this review cannot independently verify:

- that the identity comparison was evaluated before its launch permission point;
- accepted=false or launch_permitted=false for either mutant;
- execution.launch_count=0;
- either launch_count_before=0 or launch_count_after=0 canary;
- the asserted absence of forbidden child-launch tokens in the predicate; or
- the recorded stdout and outer-output hashes.

Inferring those facts from the prose that claims them would make the record its own independent
proof. The reset therefore converted the inverse result from reviewable retained evidence into an
unverifiable transcript. The preregistration requires a missing raw result or missing inverse
nonvacuity to stop the supply-chain release, so the correct verdict is unconditional NO-GO.

## 6. Claim disposition and limitations

| Claim | Disposition |
| --- | --- |
| Current subject identity and text shape | Reproduced |
| Predicate-time thirteen-input identity | Reproduced from the current subject prefix and live files |
| Current lock/config/manifest identities | Reproduced |
| Complete live vendor count, bytes, and canonical digest | Reproduced |
| Embedded vendor manifest equals live vendor tree | Reproduced byte-for-byte |
| Retained metadata registry closure equals lock and vendor | Reproduced from the retained JSON bytes |
| Config and stale-lock mutant bytes and tuple identities | Reproduced in memory |
| Physical config and lock unchanged during this audit | Reproduced by terminal hashes |
| Mutants rejected before launch with zero launches | **Not independently provable; raw result lost** |
| Fresh Cargo metadata exit/environment/tool identity | Not run; prior retained artifact only |
| Cached archive-to-vendor provenance | Not freshly re-extracted in this bounded review |
| Dependency security or license approval | Withheld |
| Build, test, runtime containment, platform support, Q-152, release, or certification | Withheld |

The surviving evidence is sufficient to preserve the exact resolver and vendor closure facts. It
is insufficient to release any later Cargo, build, test, recorder, release-documentation, or
certification gate whose prerequisite includes independently reviewable inverse controls. Root
must separately authorize any future recovery; this review neither requests nor performs a rerun.

## 7. Review command and incident ledger

- Governance and the lane skill were read before audit work.
- The subject was read with bounded Get-Content chunks until all 1,955 text lines were consumed.
- Hashes, canonical records, lock/metadata sets, and in-memory mutants were computed with one
  read-only PowerShell audit. It performed no filesystem write.
- Repository evidence lookup used read-only rg with the vendor payload excluded.
- Exact retained temp paths were inspected with read-only Get-ChildItem.
- The first sandboxed governance read failed before execution because the local sandbox helper
  could not initialize; the same read was retried outside the broken sandbox.
- The first construction of the comprehensive read-only audit failed in the orchestration
  JavaScript parser with Unexpected identifier t$. PowerShell did not start and no file was read
  or changed by that attempt. The corrected construction executed once and produced the results
  recorded above.
- Direct and root-session reads of the cited inverse key returned MISSING. No inverse was rerun.

No command in this review mutated the subject or any Rust workspace path.

## 8. Independent-review history addendum

This is a history-only addendum to the first frozen report. The complete first report was
13,348 bytes / SHA-256
F4FBF11F552E27B14DE42317A70D9613F8CD18B0A8684E430866262BB8049206,
with 242 LF bytes, zero CR bytes, no UTF-8 BOM, and a terminal LF. No tuple claim in
sections 2 or 4 is superseded by this addendum.

Three tier-3 review attempts followed that freeze:

| Reviewer | Terminal disposition | Scope and history |
| --- | --- | --- |
| Aldarion | Process **NO-GO**, not a merits finding | The local sandbox helper failed during required skill setup. No report or subject file was inspected, so no tuple-drift or substantive verdict was possible. |
| Nimloth | Unconditional **GO** | The lost-envelope reasoning, inverse-control stop condition, claim limits, and sole underlying supply-chain NO-GO were correct. Her terminal report and subject tuples matched the freeze. |
| Voronwe | Corrected unconditional **GO** after formal withdrawal | His initial tuple-arithmetic **NO-GO** was caused by his review implementation, not by the subject or this report. His corrected ordinal reconstruction matches the four tuple identities in sections 2 and 4. |

Voronwe's initial implementation called an operation equivalent to
`[Array]::Sort([string[]]$tupleRecords, ...)`. That sorted a temporary string-array cast, while
the subsequent operation equivalent to `Concat($tupleRecords)` hashed the original hash-table
enumeration order. The unordered streams produced these false review values:

- predicate-time tuple:
  `38f4fbaae6227ae002fe32f1ccbc078e49d24927618ba396da0bf69f747f13b8`;
- current-full-record tuple:
  `66e98e85ebe435935334df85c42d568437553da01342fde836994347a5bfe4bb`;
- config-mutant tuple:
  `d6f35de73056ab85eaaf662b1b4dd1a46f466e395ff4c5ef16dbc011432bf10d`;
  and
- stale-lock-mutant tuple:
  `0f2d43e0ac6b3d9ec9edc78be9659a1fdba58cb82f6597f1d7c30eb906eb7f83`.

Those values are retained only as reviewer-incident identities. They are not canonical subject
identities and must not be used as corrections.

The subject-defined grammar is
`<logical-path><TAB><decimal-byte-length><TAB><lowercase-sha256><LF>`, with `/` paths,
ordinal path sorting, UTF-8 without a BOM, and a terminal LF. Hashing the sorted 1,312-byte
streams reproduces:

| Tuple | Canonical SHA-256 |
| --- | --- |
| Predicate-time inputs | c1abf90fc4f3eaea63c4fb3e3be8d219bd1028cc1e09f319bc7173061c81ca6f |
| Current full-record comparison | a3ab97284316b0c09edc271ae440dc92db0f7956e7d44e4a22ebcae1d8c762a6 |
| Config byte-flip mutant | 31e296d0c3faa19094199aae094a038189ac43ba96d8e2749988500cb6008d42 |
| Exact stale-lock mutant | 0dc0af2a59ef246d207881d7bfa3beeca6abe7dcf9ba76d37e8cc24eca1c30ae |

Denethor and the root orchestrator independently reproduced the ordinal predicate and current
streams after the false finding. Voronwe then identified the temporary-array error, supplied the
actual unordered record order, formally withdrew his initial NO-GO, and confirmed there was no
path/value difference from the subject table. The tuple accounting and surviving closure facts
in this report therefore remain valid.

The corrected arithmetic result does not restore the raw post-lock inverse predicate source,
stdout, or outer envelope. The session key remains MISSING after the reset, so rejection before
launch and zero launch count remain unauditable from independent raw evidence. That evidence
loss is the sole underlying subject-level reason for this report's unconditional **NO-GO**.
Nothing in this addendum releases Cargo, a build, a test, runtime or platform claims,
certification, release documentation, or publication.

## 9. V3 reviewer-scope clarification

The complete V2 report was 17,015 bytes / SHA-256
FB4EB6B895F6DE4317495A4679FC14C1275099F59211727C3312FE3C90C61716,
with 301 LF bytes, zero CR bytes, no UTF-8 BOM, and a terminal LF. Two fresh tier-3
reviewers inspected that exact tuple:

- Tuor returned an unconditional **GO** after independently reproducing the complete
  input/vendor/lock/config/metadata closure, all four ordinal tuple streams, the false unordered
  predicate identity, and the terminal no-drift tuples.
- Melian returned **NO-GO** on one history-record precision issue. Section 8 recorded the joint
  predicate/current confirmation, but it did not explicitly state Denethor's wider independent
  mutant-stream coverage. She found no tuple drift and no defect in the evidence-loss reasoning,
  claim limits, or underlying supply-chain NO-GO.

The exact independent-reproduction scopes are:

- Denethor independently reproduced all four 1,312-byte ordinal streams: predicate-time inputs,
  current-full-record comparison, config byte-flip mutant, and exact stale-lock mutant.
- The root orchestrator independently reproduced the predicate-time and current-full-record
  ordinal streams. This report does not claim that root independently recomputed the two mutant
  streams.
- Tuor independently reproduced all four ordinal streams during the V2 report review.

Accordingly, the authoritative canonical hashes remain `c1abf90f...1ca6f`,
`a3ab9728...762a6`, `31e296d0...8d42`, and `0dc0af2a...30ae`. The false
`38f4fbaa...f13b8`, `66e98e85...e4bb`, `d6f35de7...f10d`, and
`0f2d43e0...7f83` values remain retained only as the withdrawn reviewer incident. Nothing in
this clarification changes sections 2 or 4, removes the incident history, or restores the lost
raw inverse evidence.

The missing predicate source, stdout, and outer envelope therefore remain the sole underlying
subject-level reason for the report's unconditional **NO-GO**. No Cargo, build, test, runtime,
platform, certification, release-documentation, or publication gate is released.
