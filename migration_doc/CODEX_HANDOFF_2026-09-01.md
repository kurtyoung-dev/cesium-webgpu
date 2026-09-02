# Codex three-day cutoff handoff — 2026-09-01

Status: **controlled pause / resume-ready, not a publication or certification GO**

Cutoff: **2026-09-01 16:12:36 EDT** (`2026-09-01T16:12:36-04:00`)

Coverage: work performed from the late-August-29 reset-safe handoff through this September 1
usage cutoff. This document supersedes the earlier incomplete September 1 draft. It preserves
committed results, reviewed but uncommitted packets, active partial repairs, research findings,
open authority questions, and the exact restart order.

## 1. Executive state

- Root remains the only Git authority. Workers performed no Git writes. Nothing was pushed.
- `main` is at `847139bb21217951c75c38d6bfdc46ee44d7e975`.
- The locally cached `origin/main` is
  `a64954b94507fa29762964f3d410517ddd765e9e`; no network fetch was performed.
- The cached comparison is **ahead 15, behind 0**. All 15 local commits use the canonical
  `cesium-webgpu-agent <cesium-webgpu-agent@users.noreply.github.com>` identity and are
  single-parent commits.
- The range is **publication NO-GO** because four immutable commits contain eight landing-message
  violations. Do not push, amend only the tip, rewrite, or bypass the guard. Section 3 records the
  required maintainer decision.
- No September 1 work is committed. Weekday quiet hours prohibit commits and pushes from
  07:00–19:00 America/New_York unless a controlling ruling says otherwise.
- The Fëanor pre-push-guard repair and Idril historical-C16 repair were paused at safe boundaries.
  Both are **mid-repair, untested, and not GO**.
- Edge/browser work remains HOLD. No browser, server, build, capture, network operation, or
  evidence publication ran during the September 1 continuation.
- The Rust process supervisor has strong Windows developer evidence, but formal certification and
  production use remain **NO-GO**.
- The `.agents` ownership/ACL repair is confirmed end to end. Its intended sandbox deny-write ACE
  is present, `.agents` remains readable, sandboxed commands launch, and native Rust execution is
  unblocked. The external backup remains intentionally undeleted at
  `F:/Dev/GH/cesium-webgpu-worker-archive/agents-ownership-backup-2026-08-31/`; it is eligible for
  retirement only through the documented two-phase procedure.

This is a custody record, not a clean-tree claim. Do not sweep, restore, reset, stash, or delete
anything listed here: the shared tree contains work from multiple governed lanes.

## 2. Exact repository and process cutoff

### 2.1 Shared tree

At the cutoff, `git status --porcelain=v1 --untracked-files=all` reported:

| State | Count |
| --- | ---: |
| Status entries | 6,119 |
| Staged tracked paths | 8 |
| Unstaged tracked paths | 36 |
| Untracked paths | 6,079 |
| Paths modified in both index and worktree | 4 |

The four mixed paths are `.gitattributes`, `Tools/pre-push-guard.mjs`,
`Tools/pre-push-guard.spec.mjs`, and `Tools/verify-landing-compliance.mjs`. The staged set also
contains `.husky/pre-push`, `Tools/landing-rules.mjs`, `Tools/landing-rules.spec.mjs`, and
`migration_doc/TOOLING_CATALOG.md`. These index entries predate this cutoff operation and were not
changed, restaged, or normalized here.

Both `git diff --check` and `git diff --cached --check` returned clean. Git emitted the known
sandbox warning that `C:\Users\Kurt\.config\git\ignore` was inaccessible; counts therefore use
repository exclusions rather than the unavailable global ignore file.

There are **7 Git worktrees** and **10 local heads**. Their exact identities, the 40 unique dirty
tracked paths, the **22 sibling lane/audit/worker Git repositories**, the separate standalone
landing repository, and the **4 non-Git evidence/archive directories** are frozen in Appendix A.
Those categories must not be conflated. Their presence is an inventory fact, not deletion or
cleanup authority.

The two non-main lineages that must not be mistaken for landed history are Batch 1337 at
`d37b1f3cb6520d9df35bdfdef707985aa2f4e165` and Batch 1339 at
`f0121cfd8d3b874d95b9b608bef2476412d00136`. The current guard does not reserve Batch numbers on
unrelated local-only branches. No worktree or sibling repository has deletion authority.

### 2.2 Processes and ports

Only the five pre-existing launcher processes were visible at pause:

- `cmd.exe`: PIDs `17092`, `18464`;
- `node.exe`: PIDs `5664`, `21128`, `26468`.

All began at approximately 10:37 EDT and predated the paused repair lanes. Those lanes left no
test or child process. No listener was present on ports `8080`, `8081`, `8094`, or `8095`.
Ports 8080/8081 remain forbidden for this campaign; any future Edge lane must use its governed
8094/8095 sequence.

### 2.3 External Codex session configuration

The external `C:/Users/Kurt/.codex/config.toml` currently contains the following agent and feature
snapshot. This records observed session state; it does not assign authorship for the restoration:

```toml
[agents]
enabled = true
max_concurrent_threads_per_session = 16

[features]
js_repl = false
apps = true
auth_elicitation = true
browser_use = true
browser_use_external = true
browser_use_full_cdp_access = true
code_mode_host = true
compaction_image_budget = true
computer_use = true
content_item_kinds = true
enable_request_compression = true
fast_mode = true
goals = true
guardian_approval = true
hooks = true
image_generation = true
in_app_browser = true
in_app_chat = true
in_app_dictation = true
in_app_local_automation = true
in_app_updates = true
mentions_v2 = true
multi_agent = true
personality = true
plugin_sharing = true
plugins = true
remote_compaction_v2 = true
remote_plugin = true
secret_auth_storage = true
shell_snapshot = true
shell_tool = true
skill_mcp_dependency_install = true
skill_search = true
tool_call_mcp_elicitation = true
tool_suggest = true
unbounded_connection_retries = true
unified_exec = true
view_image = true
workspace_dependencies = true
```

There are 39 feature keys: 38 `true`, with only `js_repl = false`. After restart, this session
exposed 17 effective concurrency slots including root, enabling the three-tier topology used here.
This is a session observation, not a repository-controlled configuration guarantee. Revalidate
the external file, feature state, and effective slot count after any cache cleanup, Codex reset,
config edit, or restart before dispatching a full wave.

## 3. Committed local history and publication blocker

The exact local-only range, oldest first, is:

| Date (EDT) | Commit | Result |
| --- | --- | --- |
| Aug 29 22:37 | `6a8a023c655b460aa49e593e6c987a89379c9308` | Batch 1330 — active workflow lanes gained tracked reset-safe handoffs. |
| Aug 30 00:03 | `7ddabd46a976428c0f608c2450ce39b77465db47` | Batch 1331 — worker handoff verification preserved explicit leases. |
| Aug 30 00:55 | `1dc3f9c360d3d020380cb63fbf7029dc76202b43` | Batch 1332 — Q-152 wave-end gate made fail closed. **Missing required trailer.** |
| Aug 30 01:21 | `72c7431f92a0d7bc8b0cbf38ce567e7553b3b96b` | Batch 1333 — banked Batch 1332's immutable landing-process red. |
| Aug 30 01:44 | `97650b7db6d5f983f87603e116fb54ca17e465fe` | Batch 1334 — worker handoffs aligned with root-owned Git. |
| Aug 30 01:47 | `ca0de6918af091f2a68078f795b6c4362f159ca0` | Batch 1335 — banked the Q-152 H0 child-contract handoff and review record. |
| Aug 30 03:55 | `1f9f245ce4334ef9cb90adf00fbf626516ca1b71` | Batch 1336 — made the Q-152 wave-end mutant EOL-robust. |
| Aug 30 11:15 | `73f85cde466254b09d8628b7128af664b30a9db6` | Batch 1338 — kept model picking live during pipeline readiness; source evidence only, not Edge certification. |
| Aug 30 12:43 | `b429c5b51871b05e2123ac193f014be775770492` | Normalized research-queue encoding. **Missing Batch prefix, body, and trailer.** |
| Aug 30 12:59 | `b429c5b51871b05e2123ac193f014be775770492` | Registered held DX cleanup lanes. **Missing Batch prefix, body, and trailer.** |
| Aug 30 15:09 | `bb18234aa5671779a6c1c725d25b7ff99ca8578f` | Batch 1340 — banked the WGSL watcher-race audit; implementation remains NO-GO. |
| Aug 30 18:38 | `5f4e2d736f1654d4d1e6ddd11cae46c886703932` | Batch 1341 — banked the exact 24-hour Codex handoff. |
| Aug 30 19:57 | `33de65b3f17e029677a5584c0b7259dae9a3e020` | Batch 1342 — completed/corrected the 24-hour handoff. |
| Aug 31 19:09 | `581ac5f5a558c4b40b6a53d355d8c249c529885a` | Batch 1343 — banked runner census and August 31 handoff: focused 16/16, landing rules 225/225, 296 specs total / 50 homed / 246 orphaned. |
| Aug 31 23:12 | `847139bb21217951c75c38d6bfdc46ee44d7e975` | Batch 1344 — reused C16 line-start indexing: `test-c16` 77/77 plus syntax and Prettier. **Missing required trailer.** |

The parsed Batch sequence is unique and monotonic in this mainline range:
`1330, 1331, 1332, 1333, 1334, 1335, 1336, 1338, 1340, 1341, 1342, 1343, 1344`.
The gap numbers 1337 and 1339 occur on the unrelated local branches identified above.

There are **8 message-policy violations across 4 commits**. `R-2026-08-14-4` records immutable
history/no rewrite. Because the first defective commit is the third commit in this range,
reconstruction would replace 13 descendant SHAs and invalidate existing citations and reviews.
Amending only `HEAD` would fix at most one of eight violations. The successor must preserve and
hold the range until the maintainer chooses one of these governed dispositions:

1. preserve the history and continue holding publication;
2. issue an exact-SHA accepted-risk ruling and authorize the narrow reviewed behavior needed to
   publish it; or
3. explicitly authorize reconstruction of the candidate history, accepting replacement of 13
   SHA identities and the resulting citation/review invalidation.

No bypass or implicit rewrite is authorized.

## 4. Reviewed but uncommitted cleanup/reuse packets

These packets reached focused author validation and independent GO at the frozen tuples shown.
They remain shared-tree work, are not committed, and must be rehashed before any future landing.
A focused GO must not be inflated into a broader suite or product claim.

### 4.1 Wave-DX queue correction

- `migration_doc/QUEUE_2026-08-29_RESEARCH_DISPATCH.md` — 216,407 bytes —
  `61895BDD2A6026E749EB84EB9CE778B84F7D1D9536DF12CD2F68A80CB9325817`.
- Independent review: GO.
- Still open: a stale status locator and DX-01 “eligible card” versus “active frontier” wording.
- DX-14 itself is PARKED/BANKED at the queue catalog row and cannot be dispatched or edited
  without an explicit maintainer release.

### 4.2 Current C16 `lineOf` reuse packet

- `Tools/c16/lib/comment-scanner.mjs` — 31,467 bytes —
  `D9B88943FB9EF0D079842C486BFB346C32E2225CC36548684CD5D4EFD4785C1B`.
- `Tools/c16/string-literal-marker-scan.mjs` — 13,781 bytes —
  `18C01BFBF2760FE9F1CAD882886FEF1939C5C95C7E4913E0E4EA9752C9826D4A`.
- `Tools/c16/string-literal-marker-scan.spec.mjs` — 14,957 bytes —
  `A0E1B41B0D04C179D07C7FEB4469003E1B4F30170D8B51C589C2E72E2554B283`.
- Focused `test-c16`: 79/79; syntax and Prettier green; independent GO.
- This is distinct from committed Batch 1344's earlier `lineStarts` reuse.

### 4.3 `mutateOrFail` reuse pilot

- `Tools/visual-regression/lib/engine-stub-bundler.mjs` — 10,350 bytes —
  `4020E28B514AB7B3321CDD567A55C45CB80ABAB9FBEF22E599F7C0F485B9B4B1`.
- `Tools/visual-regression/webgpu-pick-emission-counters.spec.mjs` — 70,002 bytes —
  `6A5551F246A68EEC6AC707C2AE912EA93783C5A9251C1CF915050F8A4141A839`.
- Exact readiness run: 50/50 in about 1,007 seconds; syntax and Prettier green; independent GO.

### 4.4 Cloc path correction

- `gulpfile.js` — 55,311 bytes —
  `E942901450D1B71D1A2A7FEE52BCA1620EF2904482DA627813009A6EC3CC3D61`.
- Corrected `packages/widget/Specs` to `packages/widgets/Specs`.
- Static review and inverse proof: GO. Runtime `cloc` validation was unavailable because Perl is
  absent; do not claim a runtime result.

### 4.5 Pragma-token regex reuse

- `Tools/rollup-plugin-strip-pragma/index.js` — 1,137 bytes —
  `4FF964617A255D4638ACE33B2A7D28150F274329117B18A94020DEC19207410F`.
- new `Tools/rollup-plugin-strip-pragma/regex.js` — 710 bytes —
  `FF9AACD22DEE50F9639ECA9CCB0164278EBA475E64F61604E6DED3BA3190525E`.
- `scripts/build.js` — 92,051 bytes —
  `43E0B35BEBDD0D55978B038B06D87D2F43474B5FF271379F1127D1B9F459B558`.
- `Tools/build-infra/wgsl-comment-strip.spec.mjs` — 7,393 bytes —
  `BD16E77841FEC355AAC5E9974833D8E3F06D1966CD028571693ADC1C61BDF9B9`.
- Focused 15/15, syntax and Prettier green; independent GO.
- The first design was rejected because importing the plugin entrypoint pulled unavailable nested
  `magic-string` dependencies. The replacement is a dependency-free leaf. The broad build-infra
  runner remains unclaimed because a companion spec is concurrently dirty.

### 4.6 WASM helper reuse

- `Tools/wasm-subrange-loader.mjs` — 3,041 bytes —
  `13C270DA88CC79042492B36B5D381ABC2F55CE0964A7FE2C4007D3F15BE4A7A3`.
- `Tools/wasm-subrange-encode-check.mjs` — 11,074 bytes —
  `554807A770881D58D2324D5C64566A199C6CBD66E7932D64E08065EEBDC03401`.
- `Tools/wasm-encode-benchmark.mjs` — 9,215 bytes —
  `DB15032319CC72E62867A5538E37E23FB15F3E511D9EE7CA6DC47B8DD26D2612`.
- Direct encode check: 18 assertions PASS. Three requested benchmark sizes: zero failures. Biting
  mutants failed as expected; independent GO.
- Pre-existing `--counts 1 --json` `RangeError`/stack-overflow behavior remains out of scope.

### 4.7 WebGPU test constants

- `installWebGPUTestConstants.js` — 1,223 bytes —
  `99E3892CD42C8067E94A0D19C20A29F1DED272CEB1D5852BAF1FFC204ACE1CC9`.
- `installWebGPUTestConstantsSpec.mjs` — 7,574 bytes —
  `94B7629BF65AAC3034A79D0F8027B3533D39385E5DB1C8CAE93FFF87D073564C`.
- Four migrated consumers: `WebGLStubBufferSpec.js` 28,373 bytes
  (`922C3BACB08E5C0C7E79122F4BD754E523AE44ACD19C4E64FFAFA0581F249283`),
  `WebGPUBufferPrimitivePackStrideSpec.js` 19,583 bytes
  (`D5051C2855E2DD96656E8ABC4D7FA78EBE479F27963B3823F6D9C0930585D6EA`),
  `WebGPUTimestampProfilerSpec.js` 13,500 bytes
  (`7271B98856B3FE140ECDEDC0E97785D82D514C889155B2AF32528255043BCC2E`), and
  `WebGPUSnapFramebufferSpec.js` 14,276 bytes
  (`718C63517C68BC2FDE083E20EB7B8149F82BEAD78105357671C5608E7C837DFA`).
- Focused helper suite 8/8 and four biting mutants: GO. Do not attribute a concurrent broad
  111/111 result to this packet.

### 4.8 Recording WebGPU buffer-device mock

- `createRecordingWebGPUBufferDevice.js` — 942 bytes —
  `6D87538918812ED883A7F65C08AE9FC7E3AEB8A83879A9BF8F43A67456760E70`.
- `createRecordingWebGPUBufferDeviceSpec.mjs` — 7,203 bytes —
  `F920B130EB492DAFBC1728C1F837B670BDD6AFB013F5EA45FF1A63993902C75C`.
- Consumers: `WebGPURingBufferAllocatorSpec.js` 7,951 bytes
  (`11371DA8020D71E629ED817CE77E535B68B88F2C987CB7BE3C5EF0286386F079`) and
  `WebGPUStorageBufferPoolSpec.js` 16,495 bytes
  (`FA1C9C19830F04175D5EB0A3B05245441751F54A2309F262405061B9A81CDD69`).
- Focused 10/10 with biting mutants: independent GO.

## 5. Active repair: pre-push/landing guard — paused, not GO

The prior six-file candidate passed author validation but independent adversarial review returned
it for repair. Prior author evidence was landing rules 66/66, guard 49/49, syntax, shell,
Prettier, byte/EOL, and process checks. That evidence does **not** certify the current partial
source because the tuple changed after review.

Current paused tuple:

- `Tools/pre-push-guard.mjs` — 30,947 bytes —
  `C2CCD3746BC717C9F41B8491D07ED7DEC463502E72088F6AFE0198852172CF20`;
- `Tools/pre-push-guard.spec.mjs` — 63,610 bytes —
  `44F42BCEC5AD6B02C51A40F6E5C64C2DB07BEB28570C468355CAE5A495440426`.

Drafted in the paused source: full local/destination ref validation, a fail-closed shallow-history
check for commit-bearing pushes, deletion-only baseline/history avoidance, and explicit DAG mutant
anchors. The spec is still the previously reviewed version and has not been updated for these
repairs.

Independent findings that remain binding:

1. **HIGH:** shallow/incomplete ancestry was treated as complete, allowing an unseen higher Batch
   ancestor to be bypassed.
2. **HIGH:** 11 top-level `hasGit()` calls perform external work during module registration. Import
   alone must be inert; only the explicit Git prerequisite may probe Git at execution time.
3. **STRUCTURAL:** the combined order-dependent mutant does not independently prove canonical
   sorting, owner selection, and per-owner evaluation. Merge, ungoverned-bridge, reset,
   first-parent, min-parent, and remote-baseline inverses are required separately.
4. **MEDIUM:** deletion-only housekeeping unnecessarily calculates the complete remote Batch
   baseline and can fail on an unrelated unseen advertised tip.
5. Malformed/control refs and canonical-key collisions need permutation controls with data-free
   diagnostics.
6. The copied-hook fixture masks source executable-mode loss with `chmod`; tracked mode `100755`
   needs a direct assertion and a `100644` inverse.

Still owed before a new freeze:

- finish all isolated fixtures and mutants for the findings above;
- add the import-registration-only sentinel and remove the 11 registration-time probes;
- preserve the existing mixed delete/create missing-tip red;
- run syntax, shell, Prettier, byte/EOL/mode, landing-rule and guard suites exactly as preregistered;
- compare processes before/after;
- freeze all six dependencies: `.gitattributes`, `.husky/pre-push`, landing rules source/spec, and
  guard source/spec; then obtain a fresh independent review.

Previously repaired behaviors that must remain green include protected refs, replacement-object
hardening via `--no-replace-objects`, `.gitattributes`, advertised sibling exclusion, remote-secret
redaction, the non-skippable Git prerequisite, duplicate destinations, deterministic DAG Batch
semantics, and quiet hours. Local hooks still cannot prevent `HUSKY=0`, `--no-verify`, missing hook
installation, mutable-author scope bypass, cross-push races, or server-side uniqueness conflicts.

## 6. Active repair: historical C16 verifier — reopened and paused, not GO

An earlier deletion/rename fail-closed packet reported 102/102 GO at an older tuple. The actual
15-commit audit then produced **43 false historical C16 errors** because the verifier did not read
the revision-local grandfather ledger. That discovery reopens the packet; never repeat the older
GO as the status of the current work.

The concrete trigger is `WebGPUModelPipelineCache.ts`: it is clean-listed and revision-
grandfathered by exact `(file, all-caps-fix-label)` rows. The live guard correctly emitted 43
warnings while the historical verifier incorrectly emitted 43 errors.

Current paused tuple:

- `Tools/verify-landing-compliance.mjs` — 141,742 bytes —
  `B0DFD327E4BC63EE9A8D04F4E12E36A84C75A10DCD463C6C6402A97086601EBD`;
- `Tools/verify-landing-compliance.spec.mjs` — 134,523 bytes —
  `8AC7A5AA1A57DA68CE28654255C24925BF44DE7E8F5D1C25DD1EDA6DF6BACC27`.

Drafted but untested: captured live-guard parser/classifier/stale bindings; exact `(file, ruleId)`
commit-local warning semantics; strict-mode errors; selected-commit and direct-parent ledger
resolution; fail-closed UTF-8/object handling; pre-introduction absence versus post-introduction
deletion; shrink-only additions; scans for removed-row targets even when source is unchanged;
current-row stale validation; grandfather metrics; and primary biting fixtures.

The semantic contract is:

- grandfathering is exact by file and rule, commit-local, and warning-only outside strict mode;
- non-grandfathered clean-list findings remain errors;
- the ledger is shrink-only; additions after introduction fail;
- stale, malformed, missing-after-introduction, unavailable, invalid-UTF-8, or non-blob policy
  state fails closed; pre-introduction absence alone means an empty policy;
- working-tree/range-head drift must never reclassify an old commit;
- removed rows must scan unchanged target sources; merge commits use current rows and consider
  removed rows from either direct parent;
- the existing source deletion/rename controls remain load-bearing.

Still owed: inspect the last patch; add unavailable/non-blob/invalid-UTF-8 ledger fixtures,
ambient worktree add/remove controls, stale target deletion/rename/no-longer-clean-listed cases,
multiple-occurrence and merge-current-row coverage, and preferably the broader malformed matrix.
Then run syntax and focused checks, the full verifier suite **exactly once**, Prettier, byte/EOL
checks, and process comparison before freezing and independently reviewing the complete tuple.
No test has run against the paused tuple.

## 7. Rust process supervisor

Location: untracked `Tools/process-supervisor/`. It is a reusable Rust workspace, not a prompt-fed
shell helper: structured requests cross a narrow protocol boundary and native adapters own process
containment. Treat all input and child output as untrusted data. It does not establish immunity to
prompt injection by assertion; its security claim depends on a fixed schema, allow-listed policy,
no evaluator/shell interpolation, bounded metrics/evidence, hostile-input tests, and independent
certification.

Windows developer ladder completed:

- supervisor core: 27/27;
- protocol: 31/31;
- Windows Job Object containment: 4/4;
- crash oracle: 4/4;
- hostile CLI: 3/3;
- Q-152 adapter: 2/2. The standalone `q152_spawn_canary` exits early without its environment
  variable and is not independent spawn proof; the generic-refusal test uses it only as the
  workload that must not launch;
- formatting, Clippy, docs, and offline locked release build: PASS.

Release binaries at the developer freeze:

| Binary | Bytes | SHA-256 |
| --- | ---: | --- |
| `proc-supervisor.exe` | 460,800 | `301493C957CED5A3B5F481159869DD3B9B8E5FE03BA2909DC077F8952F0ADF20` |
| `q152-process-runner.exe` | 498,176 | `7C91DE5143768D94FF7FF4AD2BE5B55FB3BF0F007E54D2CB9FA82F3153019F3F` |
| `supervisor-test-child.exe` | 253,440 | `A582AA48F9885861A8F380AA4B4A752DCF730EAA5A76C80E180EAEDB8F40B5F1` |

This is **developer evidence only; formal certification remains NO-GO**. README, DESIGN,
SECURITY, TEST_PLAN, and SUPPLY_CHAIN documents physically exist, but they are not certified.

The retained expected-red contract is
`Tools/process-supervisor/crates/supervisor-core/tests/backend_contract.rs`, 7,442 bytes,
`C83FB6A3D9CD61D1A8EEF4BE2ADA2ECDAF3358E547058B0DC8A4F97C446EB6FA`. Exactly one valid control
passed and four preregistered defects remained red: backend-report drift, run/request identity
drift, malformed terminal acceptance, and `NotCreated` being promoted to `Running` from root
presence. Production core remained frozen at:

| Path | SHA-256 |
| --- | --- |
| `crates/supervisor-core/src/lib.rs` | `21E681AFDAD217892F477D71A040465FF3C64970B33AE6E44A2C804C4807EC5D` |
| `crates/supervisor-core/src/evidence.rs` | `50C45F58AEFEDD04ECB7775D8E1385E8B176FEC400BB64BA30843D09ABFDCEFD` |
| `crates/supervisor-core/src/error.rs` | `8EE526C7CF15A9B14D29D6E933BCF57148928A28A6FFE6AED5AECCF8507D0E8A` |

Blocking work/decisions:

1. Maintainer ratification is required for the exact §6.3 production-path expansion:
   `crates/proc-supervisor-cli/src/main.rs`,
   `crates/q152-process-runner/src/main.rs`, and
   `tests/tests/unix_process_group.rs`.
   The §6.4 wire-level retention contract remains unchanged; the pending decision is the §6.3
   behavioral-hardening amendment and its in-process raw-terminal scope.
2. The supply-chain inverse cannot presently be reconstructed. Re-freeze/review under the pinned
   toolchain before relying on it.
3. Resolve the documentation/config contradiction between `stable` and pinned Rust `1.94.0`.
4. Native Unix process-group containment has not been validated on Unix.
5. Production contract repairs, schema/protocol/native-adapter completion, clean validation
   manifest, and independent certification are still owed.
6. Ratify the Rust trust root and exact runner names before any production Q-152 use.

Resume order:
`§6.3 ratification -> pinned-toolchain supply-chain refreeze/review -> unconditional supply-chain GO -> expected-red/core repair -> schema/protocol/native adapters -> native validation -> clean manifest -> independent certification -> certified user documentation`.

## 8. Reusable probe/script library research

The cleanup goal now explicitly includes reusable functions, classes, typings, interfaces, and
test primitives rather than rebuilding helpers per probe. The implemented pilots in Section 4
establish the pattern: narrow dependency-free boundaries, direct contract specs, named runner
homes, golden behavior, biting mutants, and two-consumer migrations before broad rollout.

Research-only findings; none authorizes implementation:

- The broader survey also ranked future mutation-harness, lunar-bake, and staged-Git-read
  primitive families. `mutateOrFail` is only the completed mutation pilot; lunar-bake and staged
  Git-read primitives remain research-only/HOLD pending exact contracts, leases, runner homes, and
  acceptance matrices.

### 8.1 PNG/CRC32 family — HOLD

- Provisional research identified 27 related RGBA/zlib candidates: 26 with
  `encodePNG({ w, h, data })` and one `{ w, W, h, H, data }` alias.
- A formal source census was not completed before the cutoff and remains owed; do not treat the
  provisional count as a frozen migration inventory.
- Keep the RGB solid-data-URL variant separate. Exclude `capture-and-diff.mjs` and
  `probe-reproject-baseline.mjs`; their stored-deflate/Adler32 byte provenance is different.
- Proposed narrow future home: `Tools/visual-regression/lib/png-rgba.mjs` exporting only
  `crc32`, `pngChunk`, and `encodeRgbaPng`, with exact current zlib behavior pinned by the caller.
- Required evidence is byte identity, not decoded-image equality: fixed golden PNG bytes,
  pre/post length and SHA parity, chunk/filter/color/CRC order, compression-option identity, and
  independent mutants. Node/zlib changes may alter IDAT bytes.
- HOLD until exact helper/spec/runner leases and a golden-byte matrix are preregistered. Migrate
  two consumers first, never all 27 at once.

### 8.2 Page diagnostics — narrow future GO, artifact consolidation HOLD

- Existing `Tools/lib/webgpu-error-gate.mjs` is used by 137 visual-regression files and has
  intentionally specialized WebGPU console semantics; do not silently broaden it.
- Generic console/page-error listeners are duplicated in `sandcastle-smoke.mjs`,
  `cross-backend-sandcastle-runner.mjs`, and the celestial harness.
- A future `attachPageDiagnostics(page, options)` may own only separate console/page-error
  arrays and an ownership-safe `detach()`. Keep screenshots, filesystem writes, reports,
  suppression, readiness, retries, and verdicts outside it.
- Use a fake-page direct Node spec and independent detach/filter/order/truncation mutants. Start
  with two low-risk consumers.
- The Batch-66 final/end-of-session runners are a strong clone family, but their names and paths
  encode evidence cutoffs. Screenshot/artifact-writer consolidation and runner removal remain HOLD
  pending authority and provenance review.

### 8.3 Tooling catalog — parked and currently inaccurate

- The generator and `Tools/lib/purpose-header.mjs` ignore parser errors despite a fail-closed
  contract.
- The 1,163-row catalog matches its stage-zero `.mjs` candidate index, not all active physical
  tools; active untracked/ignored helpers are excluded and prose/live-tree/historical metrics are
  stale.
- Future repair scope, only after DX-14 release: `.gitattributes`, generator/spec,
  purpose-header/spec, and catalog. Do not edit catalog scope before explicit release.

### 8.4 Cleanup authority boundaries

- DX-15 does not grant deletion authority. Do not delete apparent duplicates, archived runners,
  worktrees, or evidence directories merely because a helper now exists.
- DX-05 was already committed in Batch 1308; never materialize its stale duplicate card.
- Open governance decisions remain for the canonical `Tools/lib` boundary, a Node executor
  boundary, M-DX-1 runner homes, M-DX-2 ledger rotation, DX-14 release, and the Rust trust root.

## 9. Q-152 and Edge/browser state

Edge remains HOLD under the gated Tier-2 browser owner. No browser lane may start merely because
H0/H1 files exist.

Correct physical state:

- Pure H0 exists in `cesium-lane-maedhros-child-contract-20260829` and was independently GO for
  its original two-file contract, but is landing-held.
  - source: 25,463 bytes —
    `142367925069EFB2C689971D0F792A5ABF93B7F81C75EF96B975912714FB7458`;
  - spec: 23,152 bytes —
    `EC6A26B813DDA1EE2CDA900A1ECF4BC32D4B62635E54BDF04926A7DA990572AB`;
  - tracked Batch 1335 handoff: 7,281 bytes —
    `4FF73A241F036CD54EAD92AF3481A9EF757F458C98424F4A2A1A0C26805985A2`;
  - review: 10,812 bytes —
    `A02AFBD1758978C83801131585B6B2DA38C892FFE6A3AECF4B575ABD051F3EBD`.
- H1 exists in `cesium-lane-maedhros-q152-h1-20260830`:
  - `migration_doc/branches/maedhros--q152-h1-variant-child-result.md`: 232,122 bytes —
    `4C323BA7D0DAB5EBB2E65FD9CD662A2E116208896627909C2D84D4ECE01F18D8`;
  - `Tools/variant-smoke-test.mjs`: 69,124 bytes —
    `4989F92ACE733414FCE0814891782A1E2B8025A393E1F298E06CDB37BDAFFC2B`;
  - `Tools/variant-smoke-test.spec.mjs`: 107,466 bytes —
    `B6D017971F27167FA1BB6499D22909BE8601D773F6829B5FABB63E3BE3C7AEB4`.
- H1's formatted H0 differs from the reviewed original, so the original GO does not approve the
  combined assembly.
- A prospective repaired 115,675-byte spec
  (`74C88F78E05EFE621015F5396A511BE2E73C28CDE1FEDCE4D940E0D989D2D59C`) has no physical
  locator and must not be materialized from prose.
- The session-reported retained V6 run was 38 total / 35 pass / 3 fail. Failures 9 and 29 were
  identified; the third remained unknown. This is an accepted visible red and must not be
  de-scored, demoted, or described as a pass.

The actual blockers are a terminating replacement aggregate, complete receipt assembly,
re-frozen identities, independent complete-assembly review, source-to-build-to-served identity,
and explicit root release to the Edge owner. Queue status remains **Q-152 PARTIAL / NOT CERTIFIED /
OPEN**.

When those prerequisites are satisfied, use this exact sequence:

`Q-152 source/receipt repair -> freeze identities -> current served build -> C12-38 acceptance -> 3e-F -> A -> rebuild barrier -> B -> C -> Q-152 wave-end gate -> independent review`.

Before that sequence, resolve H1 V10 reviews/edit release, produce the replacement aggregate,
re-freeze, and obtain complete-assembly GO. Never ask the maintainer to verify visually; every
visual claim requires the automated probe and governed evidence path.

## 10. Other findings carried forward

These items were discovered or preserved during the three-day audit and must not be lost:

- Q130 Phase A moved from 35/37 expected red to 37/37, with five biting mutants;
  build-infra was 102/102 and shadow coverage 20/20. This is source-only evidence, not Edge
  certification.
- Session-GC V18/V19 remains HOLD.
- P-Prepare, P-Seatbelt, and VR-TC1 remain prospective/HOLD.
- AO `updateConfig` destroys only two of four relevant buffers in the observed lifecycle; the
  Q142/DM08 status records also contradict one another and need reconciliation before action.
- The WGSL watcher audit found dropped-promise and independent-instance risk; implementation is
  still NO-GO despite the audit being banked in Batch 1340.
- FeatureRenderer `EINVAL` and generator cross-drive `ENOENT` were launcher **ERROR** outcomes with
  zero product child. Do not score them as product FAILs or passes.
- A visually verifiable fix still requires an automated probe; no maintainer eyeball request may
  substitute for evidence.

## 11. Maintainer decisions needed

1. Choose the exact disposition for the four immutable message-defective commits in the current
   15-commit publication range. Until then: hold and do not push.
2. Ratify or reject the Rust §6.3 paths, Rust runner names/trust root, pinned `1.94.0` versus
   `stable`, and the supply-chain inverse recovery plan.
3. Decide whether repository-wide Batch uniqueness will use transactional server-side enforcement
   or serialized pushes; a local hook cannot make that global guarantee.
4. Release or keep parked DX-14, and settle the queue locator/DX-01 wording.
5. Decide the canonical `Tools/lib` and Node executor boundaries plus M-DX-1 runner-home and
   M-DX-2 ledger-rotation policy.
6. Authorize exact future helper leases before PNG/page-diagnostics implementation.
7. Release Q-152 H1 edits/assembly and, only after its full review, the gated Edge lane.

## 12. Safe restart order

1. Read `AGENTS.md`, the newest maintainer rulings, the executor charter, worker-isolation handoff,
   orchestration handbook, this document, and the active lane-specific handoffs. Do not infer
   authority from this summary.
2. Rehash the shared-tree tuples and recapture status/process/port state. Treat any mismatch as
   shared-state drift; report it instead of restoring it.
3. Preserve the 15-commit range and request the publication ruling before any push or history
   action.
4. Resume Fëanor's guard lane at its frozen tuple; complete fixtures/mutants/validation and obtain
   a fresh independent review.
5. Resume Idril's historical-verifier lane separately; complete grandfather fixtures, run the
   full suite exactly once, freeze, and obtain an independent review. Reviewer and repair author
   must remain separate.
6. Ratify Rust paths before resuming production/certification work; follow the Section 7 ladder.
7. Land only reviewed packets with fresh tuples, root-owned Git, clean evidence prerequisites, and
   a governing publication disposition. Do not combine unrelated shared-tree work into one commit.
8. Resume Q-152/Edge only after every Section 9 prerequisite and explicit root browser release.
9. Continue reusable-library work family by family. Never turn research GO into implementation
   authority, never mass-migrate consumers, and never delete historical/evidence runners without a
   separate ruling.

## 13. Final provenance statement

This cutoff was produced by three-tier Tolkien-named orchestration: root controlled Git and final
scope; Tier-2 leads owned coding, review, testing design, research, and documentation; Tier-3
workers independently designed mutants and audited claims. At the usage cutoff all active lanes
were stopped at safe boundaries. The handoff operation itself performed read-only Git/status/hash
and process/port inspection plus this documentation write. It did not stage, commit, push, fetch,
build, browse, publish evidence, access the network, delete files, or terminate processes.

Before naming new workers, check the live/historical name registry. Turgon was reused once, and
Elemmakil was reused before being replaced by Anarion; Tolkien-name uniqueness is operationally
important because the names are used to track authorship, review independence, and lane custody.

## Appendix A — exact custody inventory

### A.1 Git worktrees

| Path | HEAD | Branch/state |
| --- | --- | --- |
| `F:/Dev/GH/cesium-webgpu` | `847139bb21217951c75c38d6bfdc46ee44d7e975` | `refs/heads/main` |
| `F:/Dev/GH/cesium-lane-elrond-session-gc-20260830` | `b429c5b51871b05e2123ac193f014be775770492` | `refs/heads/sol/session-gc-boundary-b1ce-2026-08-30` |
| `F:/Dev/GH/cesium-lane-gandalf-q12-prettier-20260830` | `d37b1f3cb6520d9df35bdfdef707985aa2f4e165` | `refs/heads/sol/q12-prettier-reachability-233fa-2026-08-30` |
| `F:/Dev/GH/cesium-lane-thorin-q152-receipt-20260830` | `f0121cfd8d3b874d95b9b608bef2476412d00136` | `refs/heads/sol/q152-landing-receipt-233fa-2026-08-30` |
| `F:/Dev/GH/cesium-webgpu-cert-s5-3cbb82885fc7` | `034c7f74d05df64e7dc488cc6a8ce6ca52598083` | detached |
| `F:/Dev/GH/cesium-webgpu-evidence` | `f38acf65f6bab907ef2ecf59234f25d2cb6600ff` | detached |
| `F:/Dev/GH/cesium-webgpu-evidence-v9` | `99abefdc2659d3acb47a8332f64cab32b97486b0` | detached |

### A.2 Local heads

| Head | SHA |
| --- | --- |
| `main` | `847139bb21217951c75c38d6bfdc46ee44d7e975` |
| `sol/dx-handoff-doc-drift-ba64954b945-2026-08-29` | `a64954b94507fa29762964f3d410517ddd765e9e` |
| `sol/q-152-wave-end-gate-repair-ba64954b945-2026-08-29` | `a64954b94507fa29762964f3d410517ddd765e9e` |
| `sol/q12-prettier-reachability-233fa-2026-08-30` | `d37b1f3cb6520d9df35bdfdef707985aa2f4e165` |
| `sol/q152-aggregate-receipt-1f9f245ce43-2026-08-30` | `1f9f245ce4334ef9cb90adf00fbf626516ca1b71` |
| `sol/q152-child-result-contract-ba64954b945-2026-08-29` | `a64954b94507fa29762964f3d410517ddd765e9e` |
| `sol/q152-h1-variant-consumer-b806fc36ca4-2026-08-30` | `ca0de6918af091f2a68078f795b6c4362f159ca0` |
| `sol/q152-landing-receipt-233fa-2026-08-30` | `f0121cfd8d3b874d95b9b608bef2476412d00136` |
| `sol/session-gc-boundary-b1ce-2026-08-30` | `b429c5b51871b05e2123ac193f014be775770492` |
| `sol/verify-handoff-explicit-lease-ba64954b945-2026-08-29` | `a64954b94507fa29762964f3d410517ddd765e9e` |

### A.3 Dirty tracked paths

The two-character prefix is the exact index/worktree status at cutoff. These 40 unique paths
account for 8 staged entries, 36 unstaged entries, and 4 overlaps:

```text
MM .gitattributes
M  .husky/pre-push
 M Tools/build-infra/wgsl-comment-strip.spec.mjs
 M Tools/c16/lib/comment-scanner.mjs
 M Tools/c16/string-literal-marker-scan.mjs
 M Tools/c16/string-literal-marker-scan.spec.mjs
M  Tools/landing-rules.mjs
M  Tools/landing-rules.spec.mjs
MM Tools/pre-push-guard.mjs
MM Tools/pre-push-guard.spec.mjs
 M Tools/rollup-plugin-strip-pragma/index.js
MM Tools/verify-landing-compliance.mjs
 M Tools/verify-landing-compliance.spec.mjs
 M Tools/visual-regression/lib/engine-stub-bundler.mjs
 M Tools/visual-regression/q130-wgsl-derivative-uniformity.spec.mjs
 M Tools/visual-regression/skybox-resolution-policy.spec.mjs
 M Tools/visual-regression/webgpu-pick-emission-counters.spec.mjs
 M Tools/wasm-encode-benchmark.mjs
 M Tools/wasm-subrange-encode-check.mjs
 M Tools/wasm-subrange-loader.mjs
 M gulpfile.apps.js
 M gulpfile.js
 M migration_doc/FIX_QUEUE_2026-08-27_AUDIT_FINDINGS.md
 M migration_doc/QUEUE_2026-08-29_RESEARCH_DISPATCH.md
M  migration_doc/TOOLING_CATALOG.md
 M package.json
 M packages/engine/Source/Renderer/WebGPU/WebGPUPointCloudEDLState.js
 M packages/engine/Source/Scene/OceanSurfacePrimitive.js
 M packages/engine/Source/Scene/SkyBoxResolutionPolicy.ts
 M packages/engine/Source/Shaders/WebGPU/Voxels/VoxelRayMarch.wgsl
 M packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_clipByPolygons.wgsl
 M packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_effects.wgsl
 M packages/engine/Specs/Renderer/WebGPU/WebGLStubBufferSpec.js
 M packages/engine/Specs/Renderer/WebGPU/WebGPUBufferPrimitivePackStrideSpec.js
 M packages/engine/Specs/Renderer/WebGPU/WebGPURingBufferAllocatorSpec.js
 M packages/engine/Specs/Renderer/WebGPU/WebGPUSnapFramebufferSpec.js
 M packages/engine/Specs/Renderer/WebGPU/WebGPUStorageBufferPoolSpec.js
 M packages/engine/Specs/Renderer/WebGPU/WebGPUTimestampProfilerSpec.js
 M scripts/__tests__/shaderSourceToJavaScript.spec.mjs
 M scripts/build.js
```

The 6,079 untracked paths are not reproduced line by line; they include the Rust workspace/vendor
tree and the new helper/spec files identified in Sections 4 and 7. The handoff itself is untracked.
The count is the frozen custody boundary; re-enumerate and report drift before resuming.

### A.4 Standalone sibling repositories and non-Git directories

The 22 standalone sibling lane/audit/worker Git repositories, excluding the seven worktrees and
the separately identified landing repository, are:

```text
F:/Dev/GH/cesium-audit-docs
F:/Dev/GH/cesium-audit-fleet
F:/Dev/GH/cesium-audit-model
F:/Dev/GH/cesium-audit-policy
F:/Dev/GH/cesium-audit-probe
F:/Dev/GH/cesium-audit-proto
F:/Dev/GH/cesium-lane-beren-q152-mutant-eol-20260830
F:/Dev/GH/cesium-lane-celebrimbor-rust-supervisor-20260830
F:/Dev/GH/cesium-lane-faramir-handoff-verifier-20260829
F:/Dev/GH/cesium-lane-fredegar
F:/Dev/GH/cesium-lane-frodo
F:/Dev/GH/cesium-lane-maedhros-child-contract-20260829
F:/Dev/GH/cesium-lane-maedhros-q152-h1-20260830
F:/Dev/GH/cesium-lane-quickbeam
F:/Dev/GH/cesium-lane-sundisc2
F:/Dev/GH/cesium-lane-theoden-handoff-doc-20260829
F:/Dev/GH/cesium-lane-treebeard
F:/Dev/GH/cesium-lane-tuor-q152-20260829
F:/Dev/GH/cesium-lane-turgon-q152-receipt-20260830
F:/Dev/GH/cesium-lane-verify
F:/Dev/GH/cesium-worker-g6frame
F:/Dev/GH/cesium-worker-sundisc
```

The separate standalone landing repository is
`F:/Dev/GH/cesium-webgpu-landing-sol-20260826`. The four non-Git custody directories are:

```text
F:/Dev/GH/cesium-webgpu-backups
F:/Dev/GH/cesium-webgpu-visual-evidence
F:/Dev/GH/cesium-webgpu-visual-evidence-staging
F:/Dev/GH/cesium-webgpu-worker-archive
```

None of these identities grants deletion, movement, cleanup, or publication authority.
