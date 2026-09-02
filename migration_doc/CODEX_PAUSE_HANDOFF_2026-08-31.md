# Codex pause handoff — 2026-08-31

**Status:** PAUSED at the maintainer's request. This is a restart record, not a queue ruling,
certification receipt, landing grant, or push authorization. Read it after
`CODEX_HANDOFF_2026-08-31.md`; this file records only work performed after that handoff's cutoff.

## 1. Stop boundary

- Stop requested: 2026-08-31, with the final root inventory taken at
  `2026-08-31T23:24:52-04:00`.
- Branch: `main`.
- HEAD: `847139bb21217951c75c38d6bfdc46ee44d7e975`.
- `origin/main`: `a64954b94507fa29762964f3d410517ddd765e9e`.
- Nothing was pushed.
- All Tolkien workers and reviewers are stopped. The last in-flight Tier-3 queue reviewer was
  interrupted after its parent had already returned the superseded tuple.
- The Edge/browser gate remained closed. No server, browser, capture, or evidence campaign ran.

## 2. Local commit made after the prior handoff

`847139bb21217951c75c38d6bfdc46ee44d7e975` — **Batch 1344: reuse C16 line-start indexing**.

The commit contains exactly:

- `Tools/c16/lib/comment-scanner.mjs`
- `Tools/c16/string-literal-marker-scan.mjs`
- `Tools/c16/string-literal-marker-scan.spec.mjs`

It exports the existing canonical `lineStarts`, routes the string-literal scanner through it while
retaining the local compatibility seam, and pins mixed LF/CRLF, trailing-LF, UTF-16 locator, text,
JSON, and canonical-helper mutation behavior.

Validation on the committed content:

- `npm run test-c16`: 77/77 passed.
- Prettier: passed.
- `node --check` on both production modules: passed.
- Pre-commit ESLint and Prettier: passed.
- Independent Tier-2 Arwen review: GO.
- Independent Tier-3 Haldir adversarial review: GO.

The commit was made with `git commit --only`; the eight pre-existing staged paths remained staged
and were not included. No push followed.

## 3. Rust process supervisor — developer validation completed

The entire `Tools/process-supervisor/` tree remains untracked and formal certification remains
**NO-GO**. The repaired sandbox did permit real native process execution.

Green developer checks:

- `cargo test --offline --locked -p supervisor-native --all-targets`: 2/2 passed.
- Windows Job integration tests: 4/4 passed.
- Windows supervisor-crash oracle: 4/4 passed.
- Core library tests: 27/27 passed.
- Protocol library tests: 31/31 passed.
- Hostile CLI tests: 3/3 passed.
- Q-152 controller/refusal tests: 2/2 passed. The standalone `q152_spawn_canary` returns early
  without its environment variable, so it is not independent spawn proof; the generic refusal test
  uses the canary as the workload that must not launch.
- Workspace Clippy with `-D warnings`: passed.
- `cargo fmt --all -- --check`: passed after formatting only the expected-red test.
- Workspace doc tests: passed; no doctests are defined.
- `cargo build --offline --locked --release --workspace`: passed.

Release artifacts produced in `Tools/process-supervisor/target/release/`:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `proc-supervisor.exe` | 460,800 | `301493C957CED5A3B5F481159869DD3B9B8E5FE03BA2909DC077F8952F0ADF20` |
| `q152-process-runner.exe` | 498,176 | `7C91DE5143768D94FF7FF4AD2BE5B55FB3BF0F007E54D2CB9FA82F3153019F3F` |
| `supervisor-test-child.exe` | 253,440 | `A582AA48F9885861A8F380AA4B4A752DCF730EAA5A76C80E180EAEDB8F40B5F1` |

Expected-red contract file:

- `Tools/process-supervisor/crates/supervisor-core/tests/backend_contract.rs`
- 7,442 bytes
- SHA-256 `C83FB6A3D9CD61D1A8EEF4BE2ADA2ECDAF3358E547058B0DC8A4F97C446EB6FA`
- Result: exactly one valid control passed and four preregistered defects failed:
  backend-report drift, run/request identity drift, malformed terminal acceptance, and
  `NotCreated` being promoted to `Running` from root presence.

Production Rust remained frozen:

| Path | SHA-256 |
|---|---|
| `crates/supervisor-core/src/lib.rs` | `21E681AFDAD217892F477D71A040465FF3C64970B33AE6E44A2C804C4807EC5D` |
| `crates/supervisor-core/src/evidence.rs` | `50C45F58AEFEDD04ECB7775D8E1385E8B176FEC400BB64BA30843D09ABFDCEFD` |
| `crates/supervisor-core/src/error.rs` | `8EE526C7CF15A9B14D29D6E933BCF57148928A28A6FFE6AED5AECCF8507D0E8A` |

Formal certification is still blocked by the unimplemented contract repairs, allocation proof,
Unix identity/containment concerns, supply-chain prerequisite, and external provenance/evidence
work. Windows developer success must not be promoted into cross-platform certification.

## 4. Rust decision required before production editing resumes

The recommended amendment is to expand behavioral-hardening preregistration section 6.3 by three
exhaustive `RunError` consumers and explicitly scope raw-terminal retention there to the in-process
Rust API:

- `Tools/process-supervisor/crates/proc-supervisor-cli/src/main.rs`
- `Tools/process-supervisor/crates/q152-process-runner/src/main.rs`
- `Tools/process-supervisor/tests/tests/unix_process_group.rs`

The wire-level retention contract remains in section 6.4. This is the smallest truthful lease
because a new evidence-contract `RunError` variant necessarily changes all three exhaustive
consumers. Production Rust remains frozen until the maintainer accepts that amendment or chooses a
different scope.

## 5. Paused Wave-DX queue correction

The only active author path was
`migration_doc/QUEUE_2026-08-29_RESEARCH_DISPATCH.md`. It is intentionally **uncommitted and not
review-approved**.

Current normalized stop tuple:

- 215,254 bytes
- SHA-256 `13D9863DCF2256391F700460805B6BE51553641D0FDFB3431342316562843053`
- 1,180 LF, all paired as CRLF
- UTF-8 without BOM

Already present in the stopped partial correction:

- Wave 1 was restored toward its original plan-snapshot semantics.
- Section 2 now identifies the 2026-08-29 Wave-1 material as a non-authoritative historical plan.
- The reviewed DX-only corrections for landed DX-05, closed DX-11, DX-14 repair/release, and the
  current DX frontier remain substantially present.

Still incomplete at the stop:

- Restore the remaining DM-02 through DM-07, Q-141, and DM-11 Wave-1 card/dependency prose to the
  historical snapshot form.
- Restore execution notes 4 and 10 and the Wave-1 at-a-glance block.
- Reword the bottom `Dispatchable today` lead as a historical 2026-08-29 classification without
  rewriting the whole list.
- Neutralize the Wave-DX placement sentence so it points to the live ledger instead of partially
  restating Wave-1 current status.
- Finish the DX-03 singleton acceptance contract after DX-14 repair and release.
- Correct DX-09 and DX-10 to current owning-lane close/quiescence holds.
- Make the frontier say owning lanes must **close and become quiescent**, not merely land.

Exact restart procedure:

1. Rehash the queue and require the stop tuple above before editing.
2. Give one author the queue file as its sole writable path and finish only the listed corrections.
3. Normalize the complete file back to CRLF/no-BOM and freeze a new tuple.
4. Dispatch a fresh independent Galadriel review and a fresh Tier-3 Celebrimbor adversarial review
   against the physical bytes, current ledger, handoff, rulings, and unchanged queue base.
5. Commit only after both reviews return GO. Root owns that Git operation.

Do not use either superseded reviewed tuple (`25F6...` or `F18F...`) as a restart input.

## 6. Other holds preserved

- `DX-14` still requires generator repair completion and explicit maintainer release.
- `M-DX-1` runner names remain unanswered; only 50 of 296 specs currently have materialized homes.
- `M-DX-2` ledger rotation remains unanswered.
- DX-07 through DX-10 remain held on owning-lane closure/quiescence and their other named gates.
- Edge remains closed because the on-disk build is stale and not bound to current source or a served
  identity.
- No helper deletion, barrel facade, generic Node executor, broad serializer merge, or broad probe
  migration is approved.

## 7. Working-tree preservation

Eight pre-existing paths remain staged: `.gitattributes`, `.husky/pre-push`, the landing/pre-push
guard implementation and specs, `Tools/verify-landing-compliance.mjs`, and
`migration_doc/TOOLING_CATALOG.md`. Numerous unrelated tracked modifications and untracked
campaign, skybox, patch-prototype, and Rust files remain exactly in place. Consult
`git status --short` before any new lease; do not restore, clean, stash, or sweep-add them.

Registered branches/worktrees remain as reported by `CODEX_HANDOFF_2026-08-31.md`, including the
three attached `sol/*` worktrees and three detached evidence/certification worktrees. None was
created, switched, or deleted during this stopping operation.

## 8. Sandbox repair result

The `.agents` ACL repair is confirmed end to end: sandboxed Cargo builds and native Windows
process-tree/crash tests launched successfully. `.agents` is now protected by the intended
deny-write ACE while remaining readable. The external ownership backup may be retired under the
maintainer's two-phase procedure; Codex did not delete it.

