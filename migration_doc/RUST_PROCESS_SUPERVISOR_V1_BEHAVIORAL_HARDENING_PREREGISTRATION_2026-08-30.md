# Rust process-supervisor V1 behavioral-hardening preregistration

**Status:** PREREGISTERED; no command in this record has run. This is a bounded test-construction
tranche against `main` at `1f9f245ce4334ef9cb90adf00fbf626516ca1b71`. The Rust architecture and
production source are frozen. A valid red is retained and returned for a separately authorized
repair writer; neither oracle author may repair production in the same pass.

## 1. Authority, ownership, and exclusions

This tranche hardens the reusable Rust supervisor that will later be evaluated for Q-152 use. It
does not certify Q-152, change the landed wave-end tool, or authorize a browser, build server,
network access, evidence publication, or Git write. Root alone may run the commands below and bank
their results.

The two writers and their exclusive path leases are:

- **Ecthelion — Windows lifecycle/crash/inheritance oracle:**
  `Tools/process-supervisor/tests/tests/windows_supervisor_crash_oracle.rs`,
  `Tools/process-supervisor/tests/src/bin/windows_crash_driver.rs`, and the test-scoped
  Windows dependency section of `Tools/process-supervisor/tests/Cargo.toml` only.
- **Finrod — protocol/CLI hostile-input and data/control oracle:**
  `Tools/process-supervisor/crates/proc-supervisor-cli/tests/hostile_cli.rs`,
  `Tools/process-supervisor/crates/proc-supervisor-cli/src/bin/process-supervisor-test-fixture.rs`,
  the test-only dependency section of `Tools/process-supervisor/crates/proc-supervisor-cli/Cargo.toml`,
  and `Tools/process-supervisor/crates/q152-process-runner/tests/generic_policy_refusal.rs` only.

Every other path is read-only. In particular, neither writer may touch
`Tools/process-supervisor/vendor/**`, `Tools/process-supervisor/.cargo/**`,
`Tools/process-supervisor/SUPPLY_CHAIN*`, any current core/native/protocol/frontend source, any
existing test, `Cargo.lock`, root workspace dependencies, or existing design/security/test-plan
claims. The supply-chain lane owns the excluded supply-chain paths. If a leased existing manifest
changes concurrently, the affected writer stops without restoring it.

## 2. Phased execution and terminal conditions

Phase W1 covers priorities 1 and 2 only: supervisor-death cleanup and strict handle
noninheritance. Phase P1 covers priorities 3 through 5 and the generic-policy negative control in
priority 6. The writers deliver source-only packets and the exact command; they do not invoke
Cargo. Root banks at least one focused expected red before any implementation repair is
authorized. A phase terminates on a compiling focused oracle packet, a frozen red that implicates
production, a lease collision, or an inability to guarantee bounded cleanup.

No phase may be called green from source inspection. A later green must be rerun by root on the
same frozen byte/hash tuple. Any repair creates a new tuple and requires a fresh independent
review.

## 3. W1 acceptance: Windows lifecycle and inheritance

The crash driver launches a root plus at least one live descendant through the real
`WindowsJobBackend`. Test-owned ready records publish both PIDs only after the descendant is live.
The oracle opens independent `SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION` process handles to
every published member before externally hard-killing the Rust supervisor. It then requires:

1. the supervisor terminates abnormally and its stdout is empty or cannot decode as a valid
   terminal `ResponseV1::Evidence`; a fabricated or partial terminal receipt is a red;
2. every pre-opened member handle becomes signaled within 5 seconds of supervisor death and no
   queried member remains `STILL_ACTIVE`;
3. the process-handle set is independent of the Job handle, and the oracle never opens or
   duplicates the Job handle;
4. all handles and owned files are closed on every return path.

The noninheritance oracle creates an inheritable manual-reset event outside the supervisor, sends
only its numeric value to the fixture, and requires the contained subject to observe
`ERROR_INVALID_HANDLE`. The parent must still be able to signal and wait on its own event handle.
This pins the explicit handle list: the inherited stdio handles work, while the unrelated
inheritable sentinel does not cross the launch boundary.

W1 uses ready records and Windows process/event waits, not timing sleeps. Ready acquisition is
bounded at 5 seconds, each process/event wait at 5 seconds, and a focused test at 20 seconds.
After any assertion failure the oracle terminates each still-live known PID, waits it, and removes
only its unique test-owned directory. Cleanup failure is reported in addition to, never instead
of, the original red.

The focused expected-red command, to be run only by root after Ecthelion freezes the packet, is:

```text
rustup run stable cargo test --offline --locked -p process-supervisor-tests --test windows_supervisor_crash_oracle external_supervisor_kill_closes_job_and_signals_every_member -- --exact --nocapture
```

W1 mutants must demonstrate that the oracle turns red if the crash driver retains an extra Job
handle, omits `KILL_ON_JOB_CLOSE`, launches the descendant outside the Job, treats
`WAIT_TIMEOUT`/`STILL_ACTIVE` as success, accepts a valid terminal receipt after the hard kill, or
adds the unrelated sentinel to the inherited handle list. Mutants are test-local switches or
derived test fixtures; they never edit production.

## 4. P1 acceptance: actual CLI transport and hostile corpus

All CLI checks launch the built binary directly and close its stdin after writing exactly one
test-owned byte stream. Controller stdout is decoded as exactly one bounded PSUP frame; child
stdout and stderr are data and may never become a controller frame.

The roundtrip case runs the actual general CLI and a Rust fixture with an absolute working
directory containing spaces and Unicode. It proves exact, ordered argv values containing spaces,
double quotes, backslashes, an empty argument, and Unicode, plus a cleared environment with exact
names and values including empty and Unicode values. The fixture writes a lossless, length-framed
report to a create-new stdout artifact. The test compares operating-system strings, not a lossy
display form.

The hostile-output case emits invalid UTF-8, a forged PSUP header/frame, prompt-injection text,
ANSI controls, NUL bytes, and at least 64 KiB of output against a 4 KiB retention cap. Acceptance
requires one valid controller response, no forged bytes outside the child-output evidence, exact
full-stream accounting, `truncated == true`, and completed draining.

The deterministic hostile request corpus has these fourteen members: float in an integer field,
negative integer, exponent, extreme exponent, integer above `u64::MAX`, duplicate top-level field,
duplicate nested field, truncated header, truncated payload, declared length of
`MAX_FRAME_BYTES + 1`, valid frame plus one trailing byte, two concatenated frames, invalid UTF-8,
and nesting beyond the JSON recursion limit. Each process gets 5 seconds and the focused corpus
gets 45 seconds. A timeout triggers kill plus wait before the assertion is reported. Each case
must exit through the current typed malformed-frame path, emit at most one response frame no
larger than 64 KiB, keep `subject_phase == not_created` and `subject_spawned == false`, and never
panic or hang. Diagnostics are bounded and treated as untrusted data.

The locked Q-152 negative control sends a structurally valid Q-152 envelope whose program,
working directory, source tuple, and artifact paths are generic rather than the embedded frozen
policy. Its workload is a fixture that would create a canary as its first action. Acceptance is
exit 3 with typed `invalid_request`, `subject_phase == not_created`, `subject_spawned == false`,
and an absent canary. A missing embedded policy is also a pre-spawn refusal, never permission to
fall back to the general frontend.

The first two focused expected-red commands, to be run only by root after Finrod freezes the
corresponding packet, are:

```text
rustup run stable cargo test --offline --locked -p proc-supervisor-cli --test hostile_cli actual_cli_preserves_argv_env_and_cwd_exactly -- --exact --nocapture
rustup run stable cargo test --offline --locked -p proc-supervisor-cli --test hostile_cli hostile_framed_json_corpus_is_bounded_and_typed -- --exact --nocapture
```

The Q-152 negative-control command is:

```text
rustup run stable cargo test --offline --locked -p q152-process-runner --test generic_policy_refusal generic_policy_refuses_before_workload_spawn -- --exact --nocapture
```

P1 mutants must turn the appropriate oracle red when the controller forwards child stdout,
accepts trailing or duplicate frames, silently converts numeric JSON, removes the per-case
watchdog, reorders or loses an empty argv/environment value, inherits an uncleared variable,
raises the retention cap to the hostile-output size, or routes a locked-policy rejection through
the general launcher. Mutants remain inside new test/fixture paths.

## 5. Reporting packet

Each writer returns: collision audit; exact paths changed; byte count and SHA-256 per owned path;
the focused root command; tests expected to pass versus the first expected red; every preregistered
mutant and how the unchanged oracle kills it; watchdog and survivor-cleanup design; and any source
defect as a frozen finding with no production patch. No result is a Q-152 certification claim.

---

## 6. Radagast behavioral-hardening amendment

**Status: PREREGISTERED — NO IMPLEMENTATION OR EXECUTION AUTHORITY.**

This section is an append-only superseding amendment to the completeness and sequencing of this
record. It does not rewrite, erase, de-score, or silently reinterpret W1 or P1. Where the original
record and this amendment differ about later behavioral-hardening scope, prerequisites, runner
homes, or certification claims, this amendment governs that later work. No command named below has
run by authority of this amendment.

W1 and P1 remain useful **noncertifying oracle sub-waves**:

- W1 measures supervisor-process death closing the Windows Job and strict handle
  noninheritance.
- P1 measures hostile controller frames only when the test closes the writer and stdin reaches
  EOF, plus the generic Q-152 policy-refusal control.

They do not close open-writer ingress deadlocks, Windows capture EOF or teardown, post-
CreateProcessW phase truth, artifact object identity, core/backend report and terminal continuity,
Unix same-object executable use, the complete Q-152 runtime closure, or externally authenticated
runner/channel provenance.

The existing W1/P1 writable paths remain frozen to their named owners until root explicitly
releases them:

- Tools/process-supervisor/tests/tests/windows_supervisor_crash_oracle.rs
- Tools/process-supervisor/tests/src/bin/windows_crash_driver.rs
- the W1 test-scoped Windows dependency section of
  Tools/process-supervisor/tests/Cargo.toml
- Tools/process-supervisor/crates/proc-supervisor-cli/tests/hostile_cli.rs
- Tools/process-supervisor/crates/proc-supervisor-cli/src/bin/process-supervisor-test-fixture.rs
- the P1 test-only dependency section of
  Tools/process-supervisor/crates/proc-supervisor-cli/Cargo.toml
- Tools/process-supervisor/crates/q152-process-runner/tests/generic_policy_refusal.rs

Shared manifests are single-writer paths even when two lanes propose disjoint sections. Additive
test registration waits until the current manifest owner releases the whole path. Root repeats a
live collision audit before every dispatch. No worker may use a concurrent edit as permission to
restore, rebase, merge, or clean another lane.

The reusable helper and Q-152 remain separate authorities. The helper may eventually certify
bounded lifecycle and containment behavior for an exact platform tuple. The wave-end gate remains
the only product-result authority. Q-152 remains STRUCTURAL/3 until its complete runtime and
external-provenance closure exists; helper exit 0 means only a valid helper lifecycle, never a
Cesium product PASS.

### 6.1 Supply-chain and runner gate

The current SUPPLY_CHAIN.md review gate is unresolved and remains an unconditional **NO-GO** for
execution. **No Cargo command may run** while that gate is unresolved, including metadata, check,
build, test, bench, run, install, or a command described as noncertifying. A later authorization
requires a current frozen resolver/input/vendor/toolchain tuple and a fresh independent
unconditional GO. Any later workspace or member manifest change, Cargo.lock change, vendored-source
change, Cargo configuration change, or supply-chain-record change invalidates that GO and requires
another freeze and review before another Cargo command.

Before evidence-bearing execution, root separately collision-audits and owns package.json. It adds
one statically discoverable aggregate runner equivalent to:

~~~json
"test-process-supervisor-hardening": "cd Tools/process-supervisor && rustup run stable cargo test --offline --locked --workspace --all-targets"
~~~

That proposed package entry is a prerequisite, not authority to edit package.json or execute it.
Root also freezes the actual Cargo and rustc executable paths, byte hashes, versions, rustup
toolchain identity, Cargo.lock, vendored tree, nested Cargo configuration, environment, and actual
CARGO_TARGET_DIR for every authorized evidence run. Invoking Cargo from the repository root with
only --manifest-path is not an equivalent runner home because it does not prove discovery of the
nested vendored Cargo configuration.

### 6.2 Dependency order and exclusive leases

The following order is serial at every shared path. Root owns every Git write and commit; workers
make no Git write. This amendment authorizes none of these edits or commands:

1. Freeze and independently review this amendment.
2. Resolve and independently approve the current supply-chain tuple; separately add the root
   aggregate runner and status-fold wiring.
3. Add expected-red oracle files on collision-free paths. Existing W1/P1 files remain untouched.
4. Land the reusable-core wait-time contract and phase-inference repair.
5. Freeze a shared terminal/evidence/artifact schema, then land its core, protocol, Windows, Unix,
   and frontend compatibility adapters atomically where a trait or initializer changes.
6. Land pure protocol decoding/validation, then deadline-bearing controller ingress.
7. Land Windows overlapped capture, post-create truth, and stable artifact identity under one
   Windows writer.
8. Land Unix exact-object execution and pre-opened artifact identity under one Unix writer.
9. Land the Q-152 runtime manifest, runtime guards, and early Unix refusal only after the shared
   types are free.
10. Land separately governed external runner/channel provenance integration.
11. Freeze a fresh supply-chain receipt and perform independent certification per claimed
    platform.
12. Author and independently review user-facing documentation only after certification.

Candidate additive oracle paths, subject to a fresh root collision audit, are:

- Tools/process-supervisor/crates/supervisor-core/tests/backend_contract.rs
- Tools/process-supervisor/crates/supervisor-protocol/tests/validated_decode.rs
- Tools/process-supervisor/crates/proc-supervisor-cli/tests/controller_ingress.rs
- Tools/process-supervisor/crates/q152-process-runner/tests/controller_ingress.rs
- Tools/process-supervisor/tests/tests/windows_capture_teardown_oracle.rs
- Tools/process-supervisor/tests/src/bin/windows_capture_teardown_driver.rs
- Tools/process-supervisor/tests/src/bin/windows_external_writer_broker.rs
- Tools/process-supervisor/tests/tests/windows_post_creation_truth.rs
- Tools/process-supervisor/tests/tests/windows_artifact_identity.rs
- Tools/process-supervisor/tests/tests/unix_identity.rs
- Tools/process-supervisor/crates/q152-process-runner/tests/runtime_closure.rs
- Tools/process-supervisor/crates/q152-process-runner/tests/unix_fail_closed.rs

Cargo.lock, each Cargo.toml, supervisor-protocol types, the shared core schema, and package.json
have one writer at a time. Windows and Unix implementation may proceed concurrently only in
isolated clones after the shared contracts freeze, and their compatibility changes must preserve a
buildable commit boundary.

### 6.3 Smallest first tranche — reusable-core terminal contract

After this amendment receives two unconditional independent GOs and after the supply-chain gate is
separately resolved, the smallest first implementation tranche is exactly:

**New expected-red test**

- Tools/process-supervisor/crates/supervisor-core/tests/backend_contract.rs

**Production lease**

- Tools/process-supervisor/crates/supervisor-core/src/lib.rs
- Tools/process-supervisor/crates/supervisor-core/src/evidence.rs
- Tools/process-supervisor/crates/supervisor-core/src/error.rs
- new Tools/process-supervisor/crates/supervisor-core/src/contract.rs

No other production or test path belongs to this first tranche. Its expected-red predicates are
exactly:

- malicious_backend_report_drift_is_rejected
- terminal_identity_drift_is_rejected
- malformed_terminal_is_rejected_by_supervisor_run
- failed_terminal_does_not_infer_running_from_root
- valid_backend_terminal_is_accepted

The current expected red is that Supervisor::run returns an unchecked backend terminal and
TerminalRun::failed promotes NotCreated to Running merely from root presence. The repair introduces
an immutable RunContract retained across Supervisor::{prepare,run}, PreparedRun::spawn, and
RunningRun::wait. It binds the exact run ID, canonical semantic request identity, exact prepared
CapabilityReport, containment requirements, expected lifecycle progression, and terminal identity.
RunningRun::wait validates every terminal with TerminalRun::validate_against before success.
RunError gains an evidence/contract variant that retains the raw terminal evidence on validation
failure rather than discarding it. TerminalRun::failed accepts the actually observed phase and
never infers Running from root presence.

Core continuity proves consistency inside the trusted process. It does not prove that a malicious
or defective native backend truthfully observed the operating system. The native evidence boundary
remains in the trusted computing base. This tranche is collision-free from W1/P1, but **no Cargo
command may run for it while the supply-chain review gate remains unresolved**.

### 6.4 Shared terminal, evidence, phase, and artifact contract

After the first tranche, shared schema work serially leases:

- Tools/process-supervisor/crates/supervisor-core/src/lib.rs
- Tools/process-supervisor/crates/supervisor-core/src/evidence.rs
- Tools/process-supervisor/crates/supervisor-core/src/error.rs
- Tools/process-supervisor/crates/supervisor-core/src/state.rs
- Tools/process-supervisor/crates/supervisor-protocol/src/lib.rs
- the first-party Windows and Unix backend compatibility initializers
- both frontend terminal classifiers

A trait-changing start outcome or public initializer change lands atomically with both first-party
backend adapters so each root-controlled commit remains buildable. The shared model distinguishes:

- **NotCreated:** no root identity and no spawned, resumed, running, or completed lifecycle event.
- **CreatedSuspended:** the original root handle/object exists and containment placement may have
  succeeded, but no successful resume or runnable transition was observed.
- **Running:** the original root exists and a successful resume or other explicit runnable
  transition was observed. On Windows, ResumeThread returning zero is still a successful resume.
- **RefusedBeforeSpawn:** a typed rejection lifecycle exists and no subject was created.
- launch/runtime failure before creation is distinct from policy refusal.

Root presence alone never proves Running. Every failure after successful subject creation produces
partial TerminalRun evidence, not a bare SupervisorFault that discards identity or lifecycle facts.
The partial terminal retains the original root identity, observed phase, completed and attempted
containment operations, termination attempts, capture completeness, artifact facts, and whether
authoritative quiescence was established. Successful termination is not quiescence; the backend
must prove its platform-specific empty condition. Finalized is recorded only after terminal
collection reaches its declared bounded end state.

TerminalRun::validate and TerminalRun::validate_against reject disagreement among run ID, canonical
request identity, prepared capability facts, requirements, root identity, phase, lifecycle,
termination cause, artifact identities, capture-completeness claims, and quiescence. A response
cannot satisfy a requested capability merely because its own report is internally consistent; the
validated response must compare its observed facts with the original request and prepared
requirements.

The evidence schema represents each output as either a complete stream or an observed prefix. An
incomplete output retains byte count, content hash, truncation facts, and a typed incomplete reason;
it is never relabeled as a complete stream. Each durable artifact records a stable object identity
in addition to its requested path, and records flush/synchronization success separately from write
success. Stdout and stderr sinks must have distinct stable identities.

Required biting core/schema mutants include:

- skip TerminalRun::validate_against in RunningRun::wait;
- probe strong, spawn weak, and return a drifted capability report;
- change the run ID or canonical request identity after prepare;
- accept a terminal that removes a required capability;
- restore root-presence-to-Running inference;
- accept contradictory phase and lifecycle events;
- return a bare fault after subject creation;
- label an observed prefix as a complete stream;
- omit or substitute an artifact stable identity;
- treat termination success as authoritative quiescence;
- accept one-sided accounting or a PID list as an empty-containment proof.

The green controls include one valid fake backend terminal, explicit NotCreated failure without a
root, explicit CreatedSuspended post-create failure, explicit Running terminal after a runnable
transition, complete naturally drained output, and incomplete output whose prefix facts are
retained without a full-stream claim.

### 6.5 Pure protocol framing and validated APIs

Protocol framing state remains pure and operating-system independent. Its exclusive lease is:

- Tools/process-supervisor/crates/supervisor-protocol/src/lib.rs
- optionally new Tools/process-supervisor/crates/supervisor-protocol/src/frame.rs
- optionally new Tools/process-supervisor/crates/supervisor-protocol/src/validated.rs
- Tools/process-supervisor/crates/supervisor-protocol/tests/validated_decode.rs

The API makes trust level visible in the name:

- decode_frame_raw and read_frame_raw perform bounded structural framing and deserialization only;
- existing generic decoder names may remain only as backward-compatible aliases documented as raw;
- decode_request_frame validates a general request semantically after raw framing;
- decode_q152_request_frame validates the Q-152 envelope semantically after raw framing;
- response validation requires the retained original request and RunContract, including requested
  capabilities and replay/continuity facts.

Deserialization, semantic validation, consistency/replay validation, and external authentication
are four distinct predicates. A canonical nonce, request hash, or internally consistent response
does not authenticate the responding process. The API and evidence use the words raw, validated,
consistent, and authenticated only for the predicate actually established.

Protocol mutants must bite when semantic validation is skipped, trailing data is accepted, a
second frame is accepted, the request hash or nonce is changed, a prepared capability is replaced,
a raw decoder is presented as validated, response validation omits the original request, or a
forged internally consistent response is presented as externally authenticated. Green controls
include canonical general and Q-152 frames, a canonical response validated against its exact
request, and an explicitly raw decode that makes no semantic or authentication claim.

### 6.6 Deadline-bearing controller ingress

Deadline-bearing I/O lives in supervisor-native; the protocol crate receives bytes and framing
events without owning OS waits. The serial ingress lease is:

- Tools/process-supervisor/crates/supervisor-native/src/lib.rs
- new Tools/process-supervisor/crates/supervisor-native/src/ingress/mod.rs
- new Tools/process-supervisor/crates/supervisor-native/src/ingress/unix.rs
- new Tools/process-supervisor/crates/supervisor-native/src/ingress/windows.rs
- Tools/process-supervisor/crates/proc-supervisor-cli/src/main.rs
- Tools/process-supervisor/crates/q152-process-runner/src/main.rs
- Tools/process-supervisor/crates/proc-supervisor-cli/tests/controller_ingress.rs
- Tools/process-supervisor/crates/q152-process-runner/tests/controller_ingress.rs

Production ingress has one fixed **absolute 10-second deadline** covering header, payload, and the
required EOF check. It cannot be supplied or widened by JSON, argv, or environment. A test-only API
may inject a shorter duration. The deadline never resets after EINTR, a successful partial read, or
each byte. Production code must not use a detached or blocking helper thread that can survive the
deadline.

On Unix, poll(2) precedes every read(2), remaining time is recomputed against the same absolute
deadline after EINTR, and the reader requires EOF after the declared payload. On Windows,
certifying controller input requires a pipe handle identified with GetFileType. PeekNamedPipe may
bound known-available one-shot controller reads; unsupported handle kinds fail closed. This narrow
use of PeekNamedPipe is not the certified child-output capture design.

Acceptance requires:

1. partial header times out with NotCreated and zero spawn;
2. partial payload times out with NotCreated and zero spawn;
3. a complete valid frame whose writer remains open times out with NotCreated and zero spawn;
4. a valid frame followed by EOF remains valid;
5. a trailing byte and a second frame remain typed malformed input;
6. oversize and invalid-UTF-8 frames remain bounded;
7. transport-valid but semantically invalid input performs zero policy/hash filesystem access,
   creates no artifact or canary, and spawns nothing;
8. unsupported Windows controller handle kinds fail closed before policy or spawn.

A general-CLI ingress timeout folds to ERROR/2 with NotCreated. A Q-152 ingress timeout or
unsupported controller transport folds to STRUCTURAL/3 with NotCreated. The oracle correctly
observing either refusal is PASS/0; it does not turn the refused product invocation into a PASS.
Mutants must bite when the deadline is reset per read, EOF is not required, a blocking reader
thread is detached, partial input can reach policy or spawn, trailing data is ignored, or an
unsupported handle is treated as an ordinary blocking stream.

### 6.7 Windows strong-containment hardening

One Windows writer owns the implementation and new Windows oracles after the shared contract
releases:

- Tools/process-supervisor/crates/supervisor-native/src/windows/launch.rs
- Tools/process-supervisor/crates/supervisor-native/src/windows/mod.rs
- Tools/process-supervisor/crates/supervisor-native/src/windows/job.rs
- Tools/process-supervisor/crates/supervisor-native/src/windows/handle.rs
- Tools/process-supervisor/tests/tests/windows_capture_teardown_oracle.rs
- Tools/process-supervisor/tests/src/bin/windows_capture_teardown_driver.rs
- Tools/process-supervisor/tests/src/bin/windows_external_writer_broker.rs
- Tools/process-supervisor/tests/tests/windows_post_creation_truth.rs
- Tools/process-supervisor/tests/tests/windows_artifact_identity.rs

The implementation scope includes spawn_suspended, child_output, Capture, CaptureThread,
Capture::{start}, CaptureThread::{finish,cancel_and_finish}, drain, empty_output,
artifact_identity, reject_reparse_path, WindowsJobBackend::{spawn,spawn_checked},
activate_suspended, resume_failure, WindowsJobRunning::wait_inner, build_evidence, supervise_run,
observe_root, terminate_and_drain, cleanup_spawn_failure, finish_capture,
Job::{create,close,start_monitor,terminate,accounting,process_ids,wait_empty}, and the handle
ownership and duplication helpers. Naming these current symbols does not authorize preserving an
unsafe implementation shape.

#### Capture design

Job quiescence and capture EOF are independent facts. The certified child-capture mechanism
replaces anonymous synchronous CreatePipe readers with a private named-pipe pair whose
supervisor-owned read side uses FILE_FLAG_OVERLAPPED. Only the child writer is inheritable, and it
is admitted through the existing strict handle list. The supervisor uses a threadless overlapped
reactor with waitable events:

- issue overlapped ReadFile operations against the retained read handle;
- retain every OVERLAPPED, event, buffer, and handle until Windows reports completion;
- cancel the exact pending operation with CancelIoEx;
- distinguish EOF, successful bytes, cancellation, ERROR_NOT_FOUND completion races,
  ERROR_OPERATION_ABORTED, broken-pipe completion, and cancellation timeout;
- bound read, cancellation completion, finalization, and terminal return under one declared
  capture deadline;
- never follow a deadline with unconditional JoinHandle::join and never detach a blocked reader.

Broken pipe after all bytes may establish complete EOF. ERROR_OPERATION_ABORTED, cancellation
timeout, or closure before authoritative EOF produces incomplete capture. Incomplete evidence
retains the exact observed-prefix byte count and hash, sets drain_completed=false, records the
typed reason, and makes no complete-stream claim. PeekNamedPipe is not accepted for certified
child capture because availability probing does not provide an atomic read, cancellation, or EOF
contract.

The external-writer oracle:

1. starts a broker before the Job and retains its PID plus creation identity through an owned
   process handle;
2. launches the real backend subject, which duplicates its stdout writer into that live broker and
   signals a named ready event without a timing sleep;
3. emits a deterministic prefix and exits while the broker retains the writer;
4. proves authoritative Job emptiness independently while pipe EOF remains withheld;
5. requires the supervisor to return inside the capture deadline and tolerance;
6. requires runtime failure, phase Running, authoritative Job-empty quiescence,
   drain_completed=false, exact prefix byte count/hash and artifact equality, and no full-stream
   claim;
7. requires a broker write after terminal response to fail;
8. reopens the artifact only as a consumer check, verifies its stable identity, and proves its
   bytes and hash cannot change after terminal response;
9. runs a second case in the same driver and proves no accumulating capture thread or handle;
10. kills and reaps driver, root, descendant, and broker on every exit path.

Where direct Job nonmembership matters, the oracle either queries IsProcessInJob through a
test-owned duplicate query handle or labels the broker as outside-by-construction and limits the
claim accordingly.

#### Post-create truth

Every injected failure after CreateProcessW returns partial terminal evidence. The backend retains
the original process handle and records PID plus creation FILETIME; it never reopens root identity
by PID. NotCreated is possible only when no subject process exists. CreatedSuspended is required
when the original root exists but no successful resume was observed. Running is required after
successful resume, including ResumeThread returning zero. Evidence records termination attempt and
result, but authoritative quiescence is true only after Job::wait_empty establishes it. Every
created process must be proven gone, and the lifecycle reaches Finalized only after bounded
collection completes.

#### Stable artifact identity

The backend creates every mandatory stdout/stderr sink with create-new semantics before subject
creation. Supervisor handles deny write and delete sharing, and handle-based reparse inspection
rejects unsafe objects. It retains each handle through capture, flush, synchronization, hashing,
and evidence construction. Evidence binds the final path, volume identity, stable file ID, byte
count, content hash, and distinct flush result; stdout and stderr IDs cannot alias. A consumer may
reopen the final path only to verify that it still names the recorded object. Rename, replacement,
hard-link, junction, reparse, parent-swap, or post-terminal mutation must fail closed or produce an
explicit non-PASS identity result.

The Windows biting mutants include:

- restore quiescent-implies-finish or Job-empty-implies-EOF;
- ignore CancelIoEx or cancellation completion status;
- reach a deadline and then join without a bound;
- treat ERROR_OPERATION_ABORTED as EOF;
- release the broker before the intended withheld-EOF state;
- detach or leak a reader, event, process handle, or broker;
- label the observed prefix as the full stream;
- permit the late broker write or post-terminal artifact mutation;
- reopen an artifact path for the supervisor write;
- enable write/delete sharing, omit the stable file ID, or alias stdout/stderr sinks;
- accept a reparse point or parent replacement;
- mark a failed flush durable;
- restore root-presence-to-Running inference;
- return a bare post-create fault;
- report CreatedSuspended after a successful ResumeThread result of zero;
- equate termination success with quiescence without wait_empty;
- reopen root by PID, accept one-sided accounting, or allow breakaway;
- permit child PSUP headers, prompt text, ANSI bytes, or invalid UTF-8 to escape the data channel.

Green controls require natural EOF with complete drain and full hash, broker release before
terminalization with complete drain, large bounded output, cancellation/EOF race preservation of
final bytes, explicit CreatedSuspended failure before resume, and a normal Running terminal. Hard
bounds are claimed only for the exact tested Windows tuple under registered responsive-kernel and
local-filesystem conditions. An independent outer watchdog remains required.

### 6.8 Unix executable and artifact identity

The Unix writer's exclusive lease is:

- Tools/process-supervisor/crates/supervisor-native/src/unix/mod.rs
- Tools/process-supervisor/crates/supervisor-native/src/unix/process_group.rs
- new Tools/process-supervisor/crates/supervisor-native/src/unix/executable.rs
- new Tools/process-supervisor/crates/supervisor-native/src/unix/artifact.rs
- Tools/process-supervisor/tests/tests/unix_identity.rs

An expected executable hash may never be checked against a path that is later reopened for
execution. The backend opens with O_NOFOLLOW and O_CLOEXEC, requires a regular executable, records
device and inode identity, hashes the retained object, compares pre/post fstat facts, and retains
the object through spawn. There is no pathname fallback after exact-object execution fails.
Unsupported Unix targets reject expected-hash mode before spawn. Unhashed general mode may remain
only as an explicit PathBestEffort capability.

Same opened object and immutable executable bytes are different claims. A retained descriptor plus
fexecve or execveat can prove pathname replacement did not select another object, but does not
prevent an equivalent-authority writer from modifying the same inode. Linux exact-hash mode should
copy and hash the source into a sealed executable memfd, verify the seals, and execute that exact
object with execveat and AT_EMPTY_PATH. Script or shebang execution fails closed in immutable mode
until native behavior is proven. Android, macOS, BSD, Illumos, and generic Unix receive no
exact-object or immutable-byte claim until their native primitive and swap controls pass.

Every mandatory artifact sink is prepared before subject spawn:

1. start from a retained trusted root directory descriptor;
2. reject empty components, dot segments, dot-dot, NUL, alternate separators, and ambiguous
   normalization;
3. walk ancestors with openat, O_DIRECTORY, O_NOFOLLOW, and O_CLOEXEC;
4. create the final file with O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY, O_CLOEXEC, and mode 0600;
5. require a regular file with link count one;
6. retain parent and file descriptors through capture, sync, hash, and evidence;
7. record device and inode identity, then rewalk from the trusted root and verify final path
   binding;
8. return before product spawn on an invalid ancestor, collision, or identity failure.

Linux certifying mode may use openat2 with RESOLVE_BENEATH and RESOLVE_NO_SYMLINKS after native
validation. Other targets remain fail-closed where their path-resolution semantics are unproven.
POSIX descriptors and mode 0600 do not provide immunity from a hostile process with equivalent
same-user filesystem authority.

Unix mutants must bite when the executable path is swapped after hashing, the source inode is
modified, pathname fallback is restored, script fallback is allowed, artifact creation moves after
spawn, O_NOFOLLOW is removed, an ancestor becomes a symlink, the final name is pre-created, a hard
link is introduced, the final path is rebound, or an invalid preflight can increment the product
spawn canary. Green controls include exact-object native execution on each claimed target, a
detected path swap, create-new pre-opened sinks, and a final binding that still names the retained
device/inode object.

Q-152 remains STRUCTURAL/3 on every Unix V1 target because process-group containment cannot prove
authoritative descendant quiescence. A general Unix helper claim is at most the explicitly tested
best-effort behavior; source review or cross-compilation cannot establish a runtime platform claim.

### 6.9 Q-152 complete runtime closure and early Unix refusal

Q-152 integration is a separate authority from reusable-helper certification. Its serial lease,
only after shared core/protocol/native types release, is:

- Tools/process-supervisor/crates/q152-process-runner/src/main.rs
- Tools/process-supervisor/crates/q152-process-runner/src/policy.rs
- new Tools/process-supervisor/crates/q152-process-runner/src/runtime_manifest.rs
- Tools/process-supervisor/crates/q152-process-runner/tests/runtime_closure.rs
- Tools/process-supervisor/crates/q152-process-runner/tests/unix_fail_closed.rs
- new Tools/process-supervisor/crates/supervisor-native/src/runtime_bundle.rs
- the required platform implementations under
  Tools/process-supervisor/crates/supervisor-native/src/windows/
- the required platform implementations under
  Tools/process-supervisor/crates/supervisor-native/src/unix/
- protocol manifest/root types only after the protocol writer releases its path

FrozenPolicy entry-script hashes are not a runtime closure. policy::validate returns a value that
holds both the validated RunSpec and every runtime object guard through Supervisor::run; verified
files are not closed before launch. The model carries two different roots:

- a source/build provenance root;
- an executed-runtime bundle root.

Source commit and dirty-state strings remain descriptive metadata, not authentication. The runtime
manifest uses a frozen versioned, domain-separated leaf encoding containing normalized relative
path, role, byte length, SHA-256, and execution mode. Leaves are sorted deterministically and bind
leaf count, manifest hash, Merkle root, and algorithm version.

The closure includes every script, transitive module, package-resolution input, configuration,
scene, shader, asset, baseline, served response body, capture/baseline policy, and policy input that
can influence a declared Q-152 step. The exact Node executable and any unbundled native runtime,
Edge/Playwright/browser runtime, served origin, and controller build identity are either immutable
manifest leaves or explicitly pinned external trusted-computing-base facts. Unresolved dynamic
imports and runtime reads are structural gaps. There is no ambient repository or node_modules
fallback.

The bundle rejects empty or dot components, dot-dot, backslashes, ambiguous normalization, case
collisions, symlinks or reparse points, hard-link aliases, omitted manifest inputs, and artifacts
inside the sealed input bundle. An ordinary developer build without the embedded source/build and
runtime roots refuses Q-152 before product spawn.

On Windows, runtime file and directory handles deny write/delete sharing and remain live through
the run. On every Unix V1 target, Supervisor::preflight checks the frozen Q-152 containment
requirements **before** constructing FrozenPolicy or reading any policy/hash/runtime path. The Unix
refusal oracle requires canonical exit 3, STRUCTURAL, NotCreated, zero product spawns, zero
policy/hash filesystem accesses, and zero artifact or canary creation.

Q-152 closure mutants must bite when a transitive helper, configuration, scene, baseline, served
body, shader, or asset changes; an import is omitted and ambient fallback succeeds; an entry is
swapped between validation and use; a symlink, hard link, reparse point, or case alias is accepted;
the embedded root is absent or mismatched; artifacts enter the input bundle; runtime guards are
dropped before Supervisor::run; or the Unix capability check moves after policy I/O. Green controls
include a complete deterministic bundle, stable roots recomputed independently, a Windows guard
that remains held through a normal run, and an early Unix refusal with all canaries at zero.

If browser, served-resource, runtime, containment, or external-provenance closure remains
unresolved, Q-152 remains STRUCTURAL/3. There is no partial Q-152 PASS.

### 6.10 Externally pinned runner and channel provenance

EvidenceResponseV1 is an internally consistent local response, not standalone attestation.
validate_against-style APIs establish consistency and replay binding only. A nonce-visible forger
can fabricate a self-consistent response, and a self-reported executable hash, embedded HMAC key,
or in-band signature is not a trust anchor.

A separately governed trusted caller must:

- open and hash the exact runner object, retain its stable image identity, and launch that same
  object rather than hashing one path and executing another;
- retain the runner PID plus creation identity and the process/channel relationship;
- bind absolute runner path, SHA-256, stable image identity, request-frame hash, raw response-frame
  hash, nonce, channel-binding kind, and process exit;
- bind the embedded build, policy, source/build, and runtime-manifest roots;
- bind the Cargo, rustc, rustup toolchain, Cargo.lock, vendored-source, nested Cargo configuration,
  and build-environment tuple;
- record standaloneAttestation: false.

Missing or mismatched external binding is STRUCTURAL/3 before its evidence can contribute to a
product fold. A trusted launcher may compare roots echoed by the runner, but the echoed values do
not authenticate themselves. A governed key lifecycle and external trust anchor would require a
separate design; this amendment does not introduce one.

Candidate product-integration paths, only after separate root authorization and collision audit,
are:

- Tools/wave-end-gate.mjs
- Tools/wave-end-gate.spec.mjs
- package.json

Provenance mutants must bite for a sibling-pipe forged response, replayed nonce, runner path/object
swap, PID creation-identity mismatch, changed request or raw response bytes, mismatched embedded
policy/build/runtime roots, fake self-hash, missing vendor/lock/toolchain tuple, and a Q-152 result
accepted solely because validate_against reported internal consistency. Green controls include the
same pinned runner object launched by the trusted caller, exact request/response byte hashes, a
retained channel relationship, and a clean mismatch refusal before product authority is granted.

### 6.11 Exact registered runner homes

Every Cargo command below has working directory Tools/process-supervisor so the nested vendored
configuration is part of the boundary:

~~~text
rustup run stable cargo test --offline --locked -p supervisor-core --test backend_contract
rustup run stable cargo test --offline --locked -p supervisor-protocol --test validated_decode
rustup run stable cargo test --offline --locked -p proc-supervisor-cli --test controller_ingress
rustup run stable cargo test --offline --locked -p q152-process-runner --test controller_ingress
rustup run stable cargo test --offline --locked -p process-supervisor-tests --test windows_capture_teardown_oracle
rustup run stable cargo test --offline --locked -p process-supervisor-tests --test windows_post_creation_truth
rustup run stable cargo test --offline --locked -p process-supervisor-tests --test windows_artifact_identity
rustup run stable cargo test --offline --locked -p process-supervisor-tests --test unix_identity
rustup run stable cargo test --offline --locked -p q152-process-runner --test runtime_closure
rustup run stable cargo test --offline --locked -p q152-process-runner --test unix_fail_closed
rustup run stable cargo test --offline --locked --workspace --all-targets
~~~

These are statically registered homes, not execution authorization. A later authorized run records
the actual working directory, CARGO_TARGET_DIR or default-target resolution, Cargo and rustc
executable paths/hashes/versions, every CARGO_BIN_EXE fixture identity, and raw stdout/stderr.
Existing W1/P1 focused homes remain registered for those noncertifying sub-waves but remain frozen
to their original owners and gates.

### 6.12 Canonical status and exit fold

Aggregate by the maximum severity in the frozen order
**PASS/0 < FAIL/1 < ERROR/2 < STRUCTURAL/3**, while retaining every lower-level measured failure
instead of erasing it:

- **PASS/0:** every exact registered predicate passed on the frozen tuple, every positive control
  passed, every required mutant bit, cleanup and provenance are complete, and independent review is
  unconditional GO.
- **FAIL/1:** a valid, complete oracle observed a behavioral contract miss or a biting mutant
  unexpectedly survived.
- **ERROR/2:** harness, runtime, capture, cleanup, I/O, or evidence collection failed in a way that
  prevents a trustworthy completed measurement. Preserve the original measured red alongside a
  cleanup error.
- **STRUCTURAL/3:** wrong or unsupported platform, supply-chain NO-GO, missing named runner,
  source/tuple/toolchain/vendor/lock mismatch, absent runtime/provenance root, unsupported
  transport, malformed evidence, or unauthenticated evidence.

Cargo's raw test failure is normally exit 101; the evidence recorder maps raw tool exits into this
canonical vocabulary. No record may claim that Cargo itself returned canonical FAIL/1.

For Q-152, unsupported Unix containment or missing runtime/provenance prerequisites is
STRUCTURAL/3. An externally authenticated helper runtime, capture, or cleanup failure is ERROR/2.
Helper exit 0 proves a valid helper lifecycle only. Product PASS/FAIL remains the wave-end gate's
authority, and only externally bound clean helper evidence may contribute to that fold.

### 6.13 Separable root-only commit units

Workers perform no Git write. Root alone may materialize reviewed bytes and commit, and this
amendment authorizes no push. Subject to fresh collision audits, current rulings, clean manifests,
and the named independent reviews, the intended separable commit units are:

1. this append-only preregistration amendment;
2. root-owned package runner and canonical status-fold wiring;
3. additive expected-red oracle packet; land red tests separately only if governance explicitly
   permits, otherwise preserve the red artifact and land the oracle with its repair;
4. reusable-core wait-time RunContract and failed-phase-inference repair;
5. shared post-create, evidence, capture-completeness, and artifact-identity schema plus both
   first-party compatibility adapters;
6. pure protocol APIs and bounded controller ingress;
7. Windows overlapped capture, post-create truth, artifact identity, and their native oracles;
8. Unix same-object executable and pre-opened artifact identity;
9. Q-152 runtime manifest, retained runtime guards, and early Unix refusal;
10. external runner/channel provenance integration;
11. fresh supply-chain receipt and independently reviewed platform certification;
12. user-facing Rust-tool documentation after certification.

No documentation commit is mixed with behavior, schema, runner, evidence, or certification bytes.
No Windows or Unix behavior commit starts before the shared contract freezes. No external
integration commit silently grants Q-152 product authority.

### 6.14 Certification claim limits

Even after a green certification, claims are limited to the exact tested source, binary, platform,
toolchain, filesystem, policy, and evidence tuple. The maximum V1 claims are:

- Windows no-breakaway Job containment for the exact tested tuple;
- original root identity retained from the process handle created by the supervisor;
- authoritative Job-empty proof independent of capture EOF;
- bounded incomplete-capture behavior for the registered external-writer case under the stated
  responsive-kernel and local-filesystem conditions;
- artifact output bound to a retained stable sink identity;
- strict bounded and replay-consistent protocol framing with child output remaining data;
- Unix best-effort general supervision only on the exact targets and behaviors tested.

The helper and its documentation must not claim:

- hostile-code sandboxing or a general security boundary;
- prompt-injection immunity as an operating-system property;
- containment of an external broker;
- complete output after an escaped writer retains a pipe;
- immunity to a process with equivalent same-user filesystem authority;
- standalone cryptographic attestation;
- hard deadlines under a wedged kernel, driver, or filesystem;
- strong Linux, macOS, Android, BSD, Illumos, or generic-Unix descendant containment merely from
  source review or cross-compilation;
- Q-152 product certification;
- recoverable terminal evidence after the supervisor process itself crashes.

The reusable cancellation API remains a separate open V1.1/V2 design item. Deadline hardening and
cancellation vocabulary do not silently close that API gap.

### 6.15 Certification and post-certification documentation gate

Certification requires a clean validation manifest that binds the exact claim, complete transitive
source and runtime boundary, source and dirty-state identity, binaries, manifests, lock/vendor and
toolchain tuple, platform identity, runner homes, raw command exits and streams, every banked red,
positive controls, every biting mutant, cleanup/survivor facts, artifact identities, canonical
fold, and independent-review disposition. All required positives must pass, every required mutant
must bite, and no required fact may be skipped or unscored. A local diagnostic or source-only
review is not platform certification.

User-facing documentation is authored **only after** at least one exact platform tuple receives
independent certification PASS. The planned documentation set may include:

- Tools/process-supervisor/README.md
- Tools/process-supervisor/docs/USER_GUIDE.md
- Tools/process-supervisor/docs/CLI_REFERENCE.md
- Tools/process-supervisor/docs/API_GUIDE.md
- Tools/process-supervisor/docs/EVIDENCE_AND_RECEIPTS.md
- Tools/process-supervisor/docs/PLATFORM_SUPPORT.md
- Tools/process-supervisor/docs/SECURITY.md
- concise crate-level Rustdoc for the certified public contract

Documentation cites the exact certification claim IDs, frozen tuple hashes, evidence and manifest
hashes, tested platform/toolchain conditions, and known limitations. Linux, macOS, and any other
platform remain explicitly NOT RUN — UNVERIFIED until their own native certification passes.
Documentation may explain uncertified source support, but may not present it as a runtime claim.

A fresh independent documentation reviewer re-derives every support and security statement from
the frozen certification evidence. Stale-evidence controls must fail when a source, binary,
manifest, lock/vendor tuple, platform identity, evidence hash, or claim ID is changed while the
prose remains unchanged. Any overclaim, missing evidence link, conditional approval, or stale
tuple is NO-GO and reopens only the documentation lease. No user-facing documentation is drafted
or landed by authority of this preregistration amendment.

### 6.16 Freeze and review gate for this amendment

After the final append, the author records this file's exact byte count, SHA-256, line-ending
counts, BOM state, and terminal-newline state, then stops editing. Two fresh independent read-only
reviewers receive that exact tuple:

1. core/protocol/phase/ingress/dependency-order/runner-home/status-fold correctness;
2. Windows/Unix/Q-152/provenance/security/claim-limit/supply-chain/documentation coverage.

Each reviewer reads and terminally rehashes the complete file, stops on any drift, performs no
edit or Git/Cargo/build/test/binary/Node/npm/browser/network/process action, and returns
unconditional GO or NO-GO. Conditional GO is NO-GO. A finding reopens this sole record lease;
repair produces a new tuple and requires two fresh reviews. Until both exact-tuple reviews return
unconditional GO, this record grants **no implementation or execution authority**.

---

## 7. V2 review correction — narrow supersession

**Status: PREREGISTERED — NO IMPLEMENTATION OR EXECUTION AUTHORITY.**

The complete V1 reviewed tuple is preserved as the first 53,710 bytes of this file, SHA-256
3DA68D592116ECA1D31FF0A8BDA5DEFD13E1E9A57A29DA7C8FFC0441C7ED4E8E. Gwindor and Idril each
returned a process NO-GO before opening the file because the workspace helper setup failed; those
attempts are retained as infrastructure history and are not content reviews. Amroth then returned
content NO-GO because the retained W1/P1 commands lacked an exact working-directory binding.
Elwing returned content NO-GO because persistent Unix hard-link aliasing was not observed at the
terminal claim boundary and external runner identity did not bind immutable bytes to the image
actually loaded. Both content reviewers terminally rehashed the V1 tuple with no drift.

This section supersedes V1 only for those three findings. Every other V1 lease, dependency,
predicate, mutant, control, status fold, claim limit, and prohibition remains unchanged.

### 7.1 Exact retained W1/P1 invocation tuples

Every retained W1/P1 Cargo command in original §§3–4 has a mandatory working directory of exactly:

~~~text
Tools/process-supervisor
~~~

The invocation tuple is the original command text plus that working directory and the later frozen
Cargo/rustc/toolchain/lock/vendor/configuration/environment identities. Running any retained W1/P1
command from another directory, including the repository root with --manifest-path, is
STRUCTURAL/3 and is not an equivalent execution because it does not prove discovery of the nested
vendored Cargo configuration. This registration supplies no Cargo execution authority.

### 7.2 Unix terminal link-count binding

The Unix artifact requirements in §6.8 additionally require the writer to re-fstat every retained
artifact file immediately before constructing terminal evidence. At that final claim boundary,
each sink must:

- still be the same recorded device/inode object;
- still be named by the verified final path binding;
- have final link count exactly one;
- record the observed final link count in evidence.

A final link count other than one, or a dev/inode/path-binding mismatch, is an explicit non-PASS
identity failure. The biting hard-link mutant opens a valid sink, introduces and holds a hard-link
alias after the initial create-time check and before the final check, and must be rejected at the
terminal boundary. The matching green control retains final link count one and the same
device/inode/path binding through terminal evidence.

The initial and final point-in-time checks establish only the observed boundaries. They do not
prove immunity to an actor with equivalent filesystem authority adding and removing an alias
between those checks. That transient same-authority race remains outside the V1 claim.

### 7.3 Immutable runner bytes and loaded-image binding

External runner provenance in §6.10 requires immutable bytes to be bound to the image actually
loaded, not merely a stable pathname or file-object identity. A certifying trusted launcher uses a
platform-specific exact-object or immutable-object launch and verifies a loaded-image binding. If
the platform cannot prove that relationship, helper evidence remains STRUCTURAL/3.

On Windows, the launcher retains the original executable handle with sharing that denies writes
and deletion from before hashing through CreateProcess and loaded-image verification. It binds the
held object's volume identity, file ID, and SHA-256 before launch and after the loader binding is
established. It verifies that the created process loaded the same held image object and refuses any
path, object, volume/file-ID, hash, or loaded-image mismatch. The exact loader-verification
primitive must be preregistered and proven by native tests before a Windows certification claim;
this correction does not assume an unproven portable handle-to-loader API.

On Linux, the immutable-image claim requires exact sealed-object execution, for example a verified
sealed memfd launched with execveat and no pathname fallback, plus verification that the child
image derives from that sealed object. Other platforms remain STRUCTURAL/3 for this claim until a
native exact-object or immutable-object launch and loaded-image binding is independently proven.

The biting provenance mutant attempts an in-place same-object byte rewrite after hashing and before
loader binding; it must be denied or detected and must leave the result STRUCTURAL/3. Path/object
swap mutants remain required separately. The matching green control proves the immutable hashed
object and the verified loaded image are the same certified bytes. Stable identity without
immutable bytes is never sufficient for external authentication or Q-152 authority.

### 7.4 V2 freeze and review

After this append, the author freezes and reports the complete file tuple while preserving the
53,710-byte V1 prefix exactly. Two fresh independent read-only reviewers, neither Amroth, Elwing,
Gwindor, nor Idril, receive the exact V2 tuple:

1. retained-command working directory, dependency/core/protocol/status-fold consistency, and
   preservation of V1 and its review history;
2. Unix final link-count binding, immutable loaded-runner-image provenance, platform/security
   limits, mutants, controls, and absence of new overclaims.

Reviewers may use bounded escalated read/hash fallback only when the workspace helper fails before
opening the file. They perform no edit, Git/Cargo/build/test/binary/Node/npm/browser/network/process
action, terminally rehash, and return unconditional GO or NO-GO. Conditional GO is NO-GO. Until
both exact-tuple V2 reviews return unconditional GO, this record grants **no implementation or
execution authority**.

---

## 8. V3 executable ingress and Windows-capture clarification — narrow supersession

**Status: PREREGISTERED — NO IMPLEMENTATION OR EXECUTION AUTHORITY.**

The complete V2 reviewed tuple is preserved as the first 59,526 bytes of this file, SHA-256
`1E9D1E72E174267486FF1CB4AF4C60B54A5A97513F0408CBEA9E5E7C8C9FB99C`. Its first 53,710
bytes remain the immutable V1 prefix, SHA-256
`3DA68D592116ECA1D31FF0A8BDA5DEFD13E1E9A57A29DA7C8FFC0441C7ED4E8E`. Mandos returned
unconditional GO for the V2 command-working-directory, dependency, core, protocol, status-fold,
and prefix-preservation review role. Beregond returned unconditional GO for the Unix terminal-link
identity, immutable loaded-runner-image provenance, platform/security limits, mutants, and controls
review role. Those reviews approve only the exact V2 text and do not review this suffix.

This section narrowly supersedes §§6.5–6.7 where their controller-ingress and Windows-capture
mechanics were not executable enough to distinguish a valid implementation from one that blocks,
releases a request before EOF, returns while kernel I/O still owns memory, or fabricates complete
output from an observed prefix. Every earlier lease, dependency, predicate, valid red, status fold,
claim limit, and prohibition remains in force unless this section expressly narrows the conflicting
mechanic.

The supply-chain gate in §6.1 remains a categorical **NO-GO**. Approval of this V3 text does not
authorize a source edit, Cargo or Node command, binary launch, test, build, browser, evidence run,
documentation change, Git action, platform claim, or Q-152 integration. The conditional sequencing
language in §§6.2–6.3 is not a self-executing release: every later tranche still requires a fresh
root dispatch after its separately governed prerequisites are satisfied.

### 8.1 Pure EOF-sealed protocol state

For controller input, the protocol crate owns a pure incremental one-frame state machine. It
performs no clock read, wait, syscall, filesystem access, environment access, thread creation,
policy lookup, artifact creation, backend construction, or process launch. Its only input events
are a nonempty byte slice or explicit EOF. An empty byte slice is not EOF.

The observable states are:

1. `Header { received }`, retaining at most the 12-byte V1 header;
2. `Payload { declared, received }`, entered only after the complete header and declared length are
   accepted;
3. `AwaitingEof`, entered only after exactly the declared payload bytes are retained;
4. `Complete`, reached only by an explicit EOF event while in `AwaitingEof`;
5. `Rejected`, an absorbing terminal state.

The state machine satisfies all of these predicates:

- no payload allocation occurs before the complete header establishes a declared length at or below
  `MAX_FRAME_BYTES`;
- retained frame storage never exceeds `12 + MAX_FRAME_BYTES`;
- EOF in `Header` is typed `TruncatedHeader`;
- EOF in `Payload` is typed `LengthMismatch`;
- receiving any byte in `AwaitingEof`, including the first byte of a second frame, is typed
  `TrailingData` immediately and does not wait for EOF;
- a complete header and payload without EOF remains `AwaitingEof` indefinitely from the protocol
  crate's perspective;
- only EOF in `AwaitingEof` can construct the crate-owned `CompleteFrame` token;
- `CompleteFrame` has no public unchecked constructor;
- no input-derived request, semantic request hash, nonce, run ID, invocation ID, or typed envelope
  is exposed before `CompleteFrame` exists;
- JSON deserialization and general/Q-152 semantic validation occur only from `CompleteFrame`;
- byte chunking is observationally invariant: one-byte feeds, every two-chunk split, and a single
  feed produce the same terminal value or the same typed rejection;
- `Complete` and `Rejected` cannot be reopened or reused by later byte or EOF events;
- bounded reservation failure and state misuse return bounded typed errors and never panic;
- diagnostics contain only bounded enum and numeric framing facts, never attacker-controlled raw
  bytes.

The trust-level API vocabulary in §6.5 remains binding. Raw framing, semantic request validation,
response consistency, and external authentication remain four distinct predicates. Existing
`Read`-driven compatibility helpers may remain only for already finite trusted readers, must be
documented as having no deadline guarantee, and may not be called by either certifying frontend.
Both production frontends consume only a native-ingress-produced `CompleteFrame`, then invoke the
correct general or Q-152 validated decoder.

The platform-independent oracle at
`Tools/process-supervisor/crates/supervisor-protocol/tests/validated_decode.rs` must exercise every
state and transition above, every header and payload boundary, every two-chunk split, explicit EOF
at each incomplete phase, trailing data delivered in the same and a later feed, terminal-state
reuse, oversized declaration before payload reservation, and raw-versus-validated separation.
These are behavioral assertions, not source-text assertions.

### 8.2 Native absolute-deadline, EOF-gated controller ingress

`supervisor-native` alone converts operating-system readiness, bytes, and closure into protocol
events. A production frontend begins one fixed absolute ten-second controller-ingress deadline
before transport classification and before its first wait, peek, or read. The deadline covers the
header, payload, and mandatory EOF. JSON, argv, environment, request deadlines, partial progress,
interrupts, spurious readiness, and repeated zero-available observations cannot set, widen, pause,
or reset it.

Production uses a monotonic clock and checked deadline construction. Before every wait or read and
after every completed wait or read, native ingress samples the same clock. If the deadline has been
reached before newly observed bytes or EOF are committed to protocol state, the deadline wins and
the observation is not accepted. A private `cfg(test)` clock/wait seam may shorten or advance time
for native unit tests; it is not linked into either production frontend and has no runtime request,
argv, or environment control.

The certifying V1 controller transport is a sole-reader byte-stream pipe. Unsupported files,
consoles, character devices, message-mode pipes, sockets, or other handle kinds fail closed before
semantic validation, policy/hash access, artifact creation, or spawn. Supporting another transport
requires separate native preregistration and tests.

On Unix:

- the inherited controller descriptor is proven to be a pipe or FIFO before admission;
- native ingress places the owned descriptor in nonblocking mode under an RAII guard;
- `poll(2)` precedes every `read(2)`, with its timeout derived from the remaining absolute deadline;
- `EINTR` and `EAGAIN` return to the same absolute-deadline loop;
- `POLLHUP` is not itself EOF: buffered bytes are drained and only `read == 0` emits EOF;
- `POLLERR`, `POLLNVAL`, flag-management failure, and other read failures are typed ingress
  failures;
- each read is bounded by fixed scratch capacity and the protocol state's remaining admissible
  bytes; when the state awaits EOF, at most one probe byte is needed to establish trailing data;
- no blocking or detached helper thread exists, and descriptor flags and owned descriptors are
  restored or closed on every return path.

On Windows:

- `GetFileType` proves `FILE_TYPE_PIPE`, and native pipe queries prove byte-stream mode before
  admission;
- channel construction guarantees that the frontend is the sole reader;
- `PeekNamedPipe` is used only to establish a bounded number of bytes already available to a
  synchronous `ReadFile`;
- `ReadFile` never requests more than the proven available count, fixed scratch capacity, or the
  protocol state's remaining admissible bytes;
- after buffered bytes drain, `ERROR_BROKEN_PIPE` or the preregistered equivalent disconnected-pipe
  result emits EOF; zero available while a writer remains connected is not EOF;
- zero available waits through an owned waitable timer for no longer than the smaller of a fixed
  polling quantum and the remaining absolute deadline, then rechecks the same deadline;
- unexpected message-mode behavior, unsupported handle state, peek/read failure, or wait failure is
  typed and fail-closed;
- the path creates no reader thread, performs no unbounded synchronous read, and closes every owned
  timer, event, duplicate, and pipe handle on every return path.

The ten-second claim is limited to the exact tested responsive-kernel and local-pipe platform
tuple. An independent outer watchdog remains mandatory and owns kill plus wait if the native
process does not return. A wedged kernel, driver, or filesystem remains outside the hard-deadline
claim and cannot be relabeled PASS.

No frontend may call policy validation, hash a program or policy path, create an artifact or
canary, construct `Supervisor`, or spawn a subject until native ingress returns `CompleteFrame` and
the correct semantic decoder succeeds. Before that boundary, every fault response has:

- `subject_phase == not_created`;
- `subject_spawned == false`;
- `run_id`, `invocation_id`, `nonce`, and semantic `request_sha256` absent, even when buffered bytes
  resemble a valid request;
- at most one bounded controller response frame;
- no raw controller bytes in diagnostics.

A bounded raw-input-prefix byte count or hash may be retained as explicitly untrusted transport
diagnostic evidence. It must not populate or alias a validated semantic-request identity.

The shared protocol vocabulary adds distinct typed controller-ingress timeout,
unsupported-transport, and controller-I/O faults; none masquerades as malformed JSON. General-CLI
ingress timeout or unsupported transport folds to `ERROR/2`. Q-152 ingress timeout or unsupported
transport folds to `STRUCTURAL/3`. A supported-transport I/O or response-publication failure that
prevents trustworthy completion folds to `ERROR/2`. Existing malformed-frame and
semantic-invalid-request mappings remain unchanged. An oracle correctly observing a preregistered
refusal is `PASS/0` for that oracle only; it does not turn the refused invocation into product
PASS.

### 8.3 Controller-ingress executable acceptance

The registered runner homes in §6.11 remain exact and acquire no execution authority:

~~~text
rustup run stable cargo test --offline --locked -p supervisor-protocol --test validated_decode
rustup run stable cargo test --offline --locked -p proc-supervisor-cli --test controller_ingress
rustup run stable cargo test --offline --locked -p q152-process-runner --test controller_ingress
~~~

Each command has working directory exactly `Tools/process-supervisor`. No command may run while the
categorical supply-chain NO-GO remains unresolved.

After that separate gate receives a current unconditional GO and root separately authorizes
execution, the two frontend oracles launch the actual built binary through a real platform pipe and
require:

1. a partial header with the writer retained open reaches the absolute ingress deadline with no
   admitted request and zero subject actions;
2. a partial payload with the writer retained open reaches the same absolute deadline with no
   admitted request and zero subject actions;
3. a complete valid frame with the writer retained open remains unadmitted and reaches the deadline
   with zero subject actions;
4. the same valid frame followed by real pipe EOF is admitted exactly once;
5. a trailing byte and a complete second frame are each rejected before any subject action;
6. declared oversize, invalid UTF-8, malformed JSON, and semantically invalid input remain bounded
   and typed at their correct layer;
7. an unsupported controller transport fails before policy/hash reads, artifacts, canaries, or
   spawn;
8. every pre-admission response omits unvalidated request identities;
9. every timeout or harness failure triggers outer kill plus wait, closes the retained writer, and
   proves no surviving test-owned process or handle;
10. the general and Q-152 frontends produce their separately registered status and exit folds.

A real production-deadline held-open case runs for each frontend. Short-deadline exhaustive
fragmentation, interrupt, spurious-readiness, boundary, and clock-advance cases use only the private
native test seam. Each spawned case has its own outer watchdog, unique owned directory and canary,
and unconditional cleanup; cleanup failure is retained in addition to the original red.

Required biting mutants are:

- release a request when the declared payload completes but before EOF;
- treat an empty feed, zero available bytes, `POLLHUP`, or an open zero-byte pipe as EOF;
- reset the deadline after a byte, `EINTR`, `EAGAIN`, peek, or readiness event;
- accept bytes or EOF whose completion is observed after the absolute deadline;
- restore a production frontend call to blocking `read_frame(stdin)`;
- introduce or detach a blocking reader thread;
- perform a Unix read without nonblocking mode and readiness;
- request more Windows bytes than `PeekNamedPipe` proved available;
- accept a non-pipe or message-mode controller transport;
- ignore a trailing byte or second frame;
- deserialize or expose request identity before `CompleteFrame`;
- perform policy/hash, artifact, canary, backend-construction, or spawn work before semantic
  acceptance;
- map the general timeout away from `ERROR/2` or the Q-152 timeout/unsupported transport away from
  `STRUCTURAL/3`;
- echo attacker-controlled controller bytes in diagnostics.

Green controls include every chunk partition of a canonical frame plus EOF, buffered-byte drain
before Unix HUP or Windows broken-pipe EOF, a writer that closes immediately after the payload,
one-byte progress that completes within the unchanged deadline, and both frontends' exact
pre-admission fault shapes.

### 8.4 Windows capture topology and ownership

The Windows capture implementation has no capture-owned reader thread, thread pool,
asynchronous-runtime task, `JoinHandle`, `CancelSynchronousIo`, detached callback, or blocking read
whose lifetime can escape the supervising run. “Threadless” is limited to capture; it does not
silently certify unrelated Job-monitor implementation.

Each captured stream is a private, one-instance, local byte-mode named-pipe pair. The supervisor
read/server handle is created with `FILE_FLAG_OVERLAPPED`; only the connected child writer is
inheritable and only through the strict process handle list. The read handle, completion event,
`OVERLAPPED`, buffer, digest state, and retained artifact handle are non-inheritable and owned by
one reactor state until terminal completion. Pipe setup handles `ERROR_PIPE_CONNECTED` explicitly,
rejects remote clients, and fails before subject creation on an incomplete or ambiguous pair.

The supervisor services stdout and stderr capture events while the subject is live; it may not
wait for subject or Job termination while leaving a full pipe unserviced. Each stream has at most
one issued `ReadFile` at a time. Its event is reset and its `OVERLAPPED` and buffer are reused only
after the preceding operation reaches terminal completion. Buffer and `OVERLAPPED` addresses
remain stable from issue through terminal harvest.

Submission failure other than `ERROR_IO_PENDING` creates no pending operation. Immediate
completion and pending completion converge on one terminal-harvest routine. A terminal controller
response is forbidden unless, for both streams, every issued operation has exactly one terminal
harvest and the pending-operation count is zero.

### 8.5 Completion, cancellation, and return state machine

An issued operation is terminal only after its documented immediate result or
`GetOverlappedResult(..., FALSE)` establishes one of these outcomes:

1. success with `0 < transferred <= buffer_extent`: append exactly those bytes once, update ordered
   extent and digests, and never inspect or hash the unused buffer tail;
2. `ERROR_BROKEN_PIPE`: authoritative EOF, with no fabricated bytes;
3. `ERROR_OPERATION_ABORTED`: cancellation completed, capture is incomplete, and this is never EOF;
4. another error, a successful zero-byte byte-mode completion, or a transferred count outside the
   buffer extent: typed capture failure and incomplete evidence.

`ERROR_IO_INCOMPLETE` is still pending. A successful
`CancelIoEx(handle, &overlapped)` means only that cancellation was requested.
`CancelIoEx` returning `ERROR_NOT_FOUND` means only that the issue/cancel race was lost; it is
neither EOF nor completion. Any other cancellation-call failure is retained as a fault but likewise
does not discharge the issued operation. In every case the reactor continues to wait for and
harvest the exact issued operation.

If the raced operation completes with bytes, those bytes are appended exactly once before
finalization. If it completes with broken pipe, EOF may be claimed. If it completes with
`ERROR_OPERATION_ABORTED`, only incomplete capture may be claimed.

For purposes of §6.7, the declared capture bound is one immutable two-cutoff budget established
before subject launch:

1. an orderly cutoff for natural drain and EOF;
2. a later cancellation-completion cutoff for exact-operation cancellation, terminal harvest,
   artifact finalization, and terminal construction.

Both cutoffs derive from frozen supervisor policy, are monotonically checked, and cannot be set,
widened, paused, or reset by child output, JSON, argv, environment, stream order, cancellation
result, partial progress, or repeated completion races.

At the transition to capture finalization, the reactor first harvests already-signaled
completions, marks both streams closing, issues cancellation to every still-pending stream before
waiting on either one, and issues no new read thereafter. Job emptiness, root exit, successful
termination, handle close, a `CancelIoEx` return, or the orderly cutoff is individually
insufficient to discharge pending I/O.

The reactor may close or drop a read handle, event, `OVERLAPPED`, or buffer only after the exact
operation has reached terminal harvest. An ordinary function return requires both stream pending
counts to be zero, all read handles to be closed after their final harvest, and no kernel operation
that can still access reactor-owned storage.

### 8.6 Logical extents and artifact evidence

For each stream the shared schema distinguishes `CompleteEof` from `Incomplete(reason)` and
records at least:

- contiguous `observed_prefix_bytes` and `observed_prefix_sha256` over all and only terminally
  completed bytes in stream order;
- `retained_prefix_bytes`, `retained_prefix_sha256`, and `discarded_observed_bytes`, with
  `retained_prefix_bytes = min(observed_prefix_bytes, max_bytes)` and
  `discarded_observed_bytes = observed_prefix_bytes - retained_prefix_bytes`;
- `eof_observed`, cancellation-request and cancellation-completion facts, completion count, and
  `pending_operations_at_terminal`, which must be zero for every emitted terminal;
- when a sink exists, its retained stable identity, actual `artifact_logical_extent_bytes`, hash of
  exactly `[0, artifact_logical_extent_bytes)` read from that retained object, and separate write,
  flush, and synchronization results.

`total_bytes` or `full_stream_sha256` may be present only when authoritative EOF was observed; an
incomplete prefix never populates or aliases a full-stream field. `truncated == false` means only
that the observed prefix did not exceed the retention cap; it never converts incomplete capture
into complete capture.

A successful artifact requires:

- `artifact_logical_extent_bytes == retained_prefix_bytes`;
- exact artifact/prefix hash equality;
- no gap or extra tail;
- unchanged stable identity;
- successful flush and synchronization.

Extent, identity, and hash are measured through the retained object, not a pathname reopen;
reopening is a later consumer binding check only. A partial artifact write records its actual
extent and error and folds non-PASS. Bytes from an unharvested operation are never counted, hashed,
written, or exposed. Bytes from a completion that wins a cancellation race are committed exactly
once. No artifact byte, digest, extent, or evidence field may change after terminal construction.

### 8.7 Nonreturning fail-stop and independent outer watchdog

If the cancellation-completion cutoff expires while any capture operation remains pending, the
in-process code must not close or drop its handle, event, `OVERLAPPED`, or buffer; unwind; fabricate
incomplete terminal evidence; flush a controller response; or return. It enters a nonreturning
fail-stop path and terminates the supervisor process with canonical `ERROR/2`. If the Windows
termination primitive unexpectedly returns, the process takes a non-unwinding abort path. This
branch makes no recoverable `TerminalRun` or terminal-response claim.

Every Windows capture oracle and every later trusted production caller therefore has an
independent outer watchdog holding the supervisor process handle and an absolute deadline fixed
before launch. The native oracle uses a 250-millisecond injected cleanup budget and a five-second
outer deadline. If no valid single terminal frame and signaled supervisor exit arrive by that
deadline, the watchdog terminates and waits the supervisor, then kills and reaps every test-owned
root, descendant, and external broker through pre-opened identities.

A witnessed fail-stop exit, or an outer-watchdog kill after the supervisor failed to signal, folds
to helper `ERROR/2`, records `terminalEvidenceAvailable == false`, and never synthesizes
`TerminalRun`, PASS, FAIL, EOF, quiescence, or Q-152 authority. Failure of the outer harness to
terminate and reap remains `ERROR/2` with incomplete cleanup; it is not hidden as a product
result. Missing or malformed outer-watchdog provenance is `STRUCTURAL/3`. No hard-deadline claim
extends to a wedged kernel, driver, or filesystem.

### 8.8 Windows executable controls and biting mutants

The focused runner remains the §6.11 command, from working directory exactly
`Tools/process-supervisor`:

~~~text
rustup run stable cargo test --offline --locked -p process-supervisor-tests --test windows_capture_teardown_oracle
~~~

It remains a registered future runner only. It may not run until the separately frozen
supply-chain tuple has unconditional GO and root separately releases the exact oracle tuple.

The Windows oracle packet uses deterministic ready/event barriers rather than sleeps and executes
all of these positive controls:

1. empty and nonempty natural EOF on both streams, exact bytes, hashes, extents, and zero pending
   operations;
2. output larger than the pipe buffer and retention cap, proving continuous servicing, full
   completed-stream accounting, bounded retention, and exact artifact extent;
3. Job empty while an outside-Job broker retains a writer: bounded
   `Incomplete(writer_retained)` with exact prefix facts, authoritative Job-empty evidence kept
   separate, no full-stream field, and a post-terminal broker write that fails;
4. cancellation wins with `ERROR_OPERATION_ABORTED`;
5. completion wins the cancellation race and `CancelIoEx` returns `ERROR_NOT_FOUND`, with raced
   bytes retained exactly once;
6. EOF wins the same race, allowing complete capture only from the harvested broken-pipe outcome;
7. cancellation completion is delayed but delivered before the cutoff, proving no early response
   or storage release;
8. injected noncompletion through the native-call test seam, proving no terminal frame,
   nonreturning fail-stop, outer-watchdog observation or kill, and complete reap;
9. stdout and stderr complete in opposite orders without cross-stream state reuse;
10. a second run in the same driver has no accumulating capture-owned thread, pipe, event, file, or
    process handle and no late artifact mutation.

The unchanged oracle must turn red for every mutant that:

- restores `CreatePipe` plus a blocking reader thread;
- spawns or detaches capture work;
- issues two reads on one stream;
- reuses or drops an `OVERLAPPED`, event, buffer, or handle before terminal harvest;
- treats `CancelIoEx` success or `ERROR_NOT_FOUND` as completion;
- treats `ERROR_OPERATION_ABORTED`, successful zero-byte completion, Job emptiness, or termination
  success as EOF;
- ignores or double-counts bytes that win a cancellation race;
- hashes the allocated buffer rather than the transferred extent;
- resets a cutoff per stream, completion, or cancellation result;
- waits or joins after the cancellation-completion cutoff;
- emits a response with pending I/O;
- returns or unwinds instead of fail-stopping;
- removes or weakens the outer watchdog;
- fabricates a terminal after fail-stop;
- populates a full-stream field for incomplete capture;
- hashes an artifact by reopening its path;
- accepts an artifact gap, extra tail, identity drift, extent/hash mismatch, or failed flush;
- aliases stdout and stderr state;
- permits the late broker write;
- leaks a capture-owned resource across the second run.

### 8.9 V3 freeze and future source-review gates

After this suffix is physically appended, the author records the complete file's byte count,
SHA-256, LF/CR counts, BOM state, and terminal-newline state and separately proves:

- the first 59,526 bytes still hash to
  `1E9D1E72E174267486FF1CB4AF4C60B54A5A97513F0408CBEA9E5E7C8C9FB99C`;
- the first 53,710 bytes still hash to
  `3DA68D592116ECA1D31FF0A8BDA5DEFD13E1E9A57A29DA7C8FFC0441C7ED4E8E`.

Two fresh independent read-only reviewers receive that exact V3 tuple. Neither reviewer may be
Caranthir, Morwen, Aerin, Mandos, Beregond, or a prospective implementation/oracle author.

1. The protocol/Unix/Q-152 reviewer checks the absorbing incremental state, EOF-only release,
   prevalidation identity absence, memory bounds, trust-level API separation, native-only absolute
   deadline, Unix and Windows controller transport behavior, side-effect canaries, status folds,
   runner homes, dependency order, supply-chain preservation, and both immutable prefixes.
2. The Windows lifecycle/evidence reviewer checks the private named-pipe and overlapped topology,
   one-operation ownership invariant, complete `CancelIoEx`/`ERROR_NOT_FOUND` race table,
   zero-pending-before-return gate, logical-extent/full-stream distinction, retained-object artifact
   proof, nonreturning fail-stop, independent outer-watchdog fold, every positive control and
   biting mutant, existing security limits, and both immutable prefixes.

Reviewers may use bounded escalated read/hash fallback only if the workspace helper fails before
opening the file. They perform no edit, Git, Cargo, build, test, binary, Node, npm, browser,
network, evidence-publication, or other state-changing action. Each terminally rehashes the full
file and both prefixes and returns unconditional GO or NO-GO. Conditional GO is NO-GO. Any byte
drift or finding reopens only this record lease, produces a new tuple, and requires two fresh
reviews. The Mandos and Beregond V2 reviews cannot substitute for either V3 review.

If the V3 record later receives both GOs, future source work remains serial:

1. the §6.5 protocol paths and `validated_decode.rs` freeze as one protocol tuple and receive a
   fresh independent protocol-state review before any native-ingress or frontend writer begins;
2. after that tuple releases, one ingress writer exclusively owns the §6.6 native-ingress,
   frontend, and controller-ingress oracle paths; the frozen implementation receives separate
   protocol/frontend and native-transport lifecycle reviews;
3. only after the shared §6.4 schema releases may one Windows writer own the §6.7 capture and
   oracle paths; the frozen implementation receives separate Windows lifecycle and output-evidence
   reviews.

Every future implementation reviewer receives an exact frozen tuple, stops on drift, and reviews
only after a separate root dispatch. A review of this V3 record or any future source tuple does not
release Cargo, weaken the categorical supply-chain NO-GO, authorize a subsequent tranche, certify
a platform, grant Q-152 product authority, or authorize documentation, landing, or push.

---

## 9. V4 executable memory, cancellation, harvest, and durability correction — narrow supersession

**Status: PREREGISTERED — NO IMPLEMENTATION OR EXECUTION AUTHORITY.**

The complete V3 tuple is preserved as the first 87,821 bytes of this file, SHA-256
`1EB5D8CC19C90D0B627E2B1C2767248A12B1C0786AAEE6E43250D80138D9A786`, with 1,419 LF,
zero CR, no BOM, and a terminal LF. Within that immutable prefix:

- the first 59,526 bytes are the V2 prefix, SHA-256
  `1E9D1E72E174267486FF1CB4AF4C60B54A5A97513F0408CBEA9E5E7C8C9FB99C`;
- the first 53,710 bytes are the V1 prefix, SHA-256
  `3DA68D592116ECA1D31FF0A8BDA5DEFD13E1E9A57A29DA7C8FFC0441C7ED4E8E`;
- bytes 59,527 through 87,821 are the 28,295-byte V3 suffix, SHA-256
  `57DB2F733CB813C32BFA86090CC99EC9DCD052A156B67E8325DEB57B366014DB`.

The two independent V3 review roles returned NO-GO on four HIGH omissions: the memory bounds in
§8.1 lacked executable allocation-failure and duplicate-storage controls; §8.5 lacked a
non-vacuous both-stream cancellation-order control; §§8.4–8.5 lacked the complete native
issue/cancel/harvest outcome matrix; and §8.6 lacked an independent synchronization-failure
control. All other reviewed protocol, Unix, Q-152, Windows, dependency-order, status-fold,
claim-limit, and prefix-preservation surfaces were coherent and remain unchanged.

This section supersedes only those four executable-acceptance omissions. It does not erase,
replace, weaken, or de-score any V1, V2, or V3 predicate, control, mutant, lease, runner, fold,
security limit, or review history. The supply-chain gate in §6.1 remains a categorical **NO-GO**.
Nothing in V4 authorizes a Rust or other source edit, Cargo, Node, npm, test, build, binary,
browser, network, evidence, Git, documentation, platform-certification, Q-152, landing, push, or
other external-state action.

### 9.1 Executable pure-protocol allocation and retained-storage controls

This subsection makes only §8.1's pure protocol memory predicates executable. The registered
future command remains exactly:

~~~text
rustup run stable cargo test --offline --locked -p supervisor-protocol --test validated_decode
~~~

Its working directory remains exactly `Tools/process-supervisor`. It may not run until the
categorical supply-chain gate receives a current unconditional GO and root separately authorizes
that exact frozen oracle tuple.

For this oracle, **live retained frame storage** is the fixed 12-byte header backing extent plus
the capacities, not lengths, of every simultaneously live protocol-owned allocation capable of
retaining controller-frame bytes. Payload, staging, scratch, replacement, duplicate, and
`CompleteFrame` handoff buffers are included. A reallocation counts both old and new extents while
both are live. Borrowed caller input, allocations made by semantic decoding after `CompleteFrame`,
allocator metadata and internal transient overcommit, native-ingress scratch, total process heap,
RSS, and OS resources are outside this narrowly named quantity.

The oracle pre-creates feed bytes and expected values outside the measured interval, executes in
an isolated test process, and uses allocation-free bookkeeping to observe every protocol-owned
frame-buffer allocation, reallocation, ownership transfer, and deallocation on the actual
production framing path. It records unique backing identities, capacities, current live capacity,
and the peak. A self-reported storage counter without the allocation observer is insufficient.
The state or token remains live through each observation and is dropped before measurement is
disarmed. This establishes a tuple-scoped Rust frame-buffer-capacity claim, not a physical-memory
or platform-wide bound.

The unchanged oracle adds these four controls:

1. **No pre-header or premature payload allocation.** Construct the state and feed every header
   prefix through byte 11. Each retains only the fixed 12-byte header and records zero payload
   reservations and zero heap-backed frame storage. Complete bad-magic, bad-version, and
   `MAX_FRAME_BYTES + 1` headers produce typed absorbing rejection with no reservation. Complete
   accepted headers declaring `0`, `1`, and `MAX_FRAME_BYTES` are then fed. Only after every header
   field and the declared bound are accepted may a nonzero case make exactly one fallible payload
   reservation. A header and payload delivered in one feed preserves the same ordering. No
   `CompleteFrame`, typed request or envelope, semantic hash, nonce, run ID, or invocation ID is
   observable in any pre-EOF case.
2. **Accepted-size forced reservation failure.** A private deterministic reservation seam on the
   same call path as production's fallible reservation rejects a valid accepted nonzero size,
   including a separate `MAX_FRAME_BYTES` boundary case, before any successful payload allocation.
   Under `catch_unwind`, the feed returns exactly one bounded typed domain error such as
   `PayloadReservationFailed { declared }`, enters absorbing `Rejected`, retains no payload or
   semantic value, exposes no attacker bytes, makes no second reservation, and returns typed
   terminal-state misuse for later byte or EOF events. The isolated process exits normally;
   panic, abort, hang, retry, or semantic exposure is red. The seam is `cfg(test)` only, has no
   request, argv, environment, or production-frontend control, and makes no claim that host OOM was
   induced.
3. **Observable peak at or below `12 + MAX_FRAME_BYTES`.** For declarations `0`, `1`,
   `MAX_FRAME_BYTES - 1`, and `MAX_FRAME_BYTES`, run a single feed, every two-chunk boundary, and
   one-byte payload feeds through `Header`, `Payload`, `AwaitingEof`, and explicit-EOF `Complete`.
   At every transition and allocator high-water mark require
   `12 + sum(all live protocol frame-buffer capacities) <= 12 + MAX_FRAME_BYTES`. Failure and
   rejection paths retain no payload storage after state drop, with no leaked extent.
4. **One backing store through `CompleteFrame` handoff.** Retain allocation identity and capacity
   observations across `Payload -> AwaitingEof -> Complete`. EOF transfers the accepted payload
   allocation into `CompleteFrame` without clone, repack, second full-size scratch, replacement,
   or simultaneous old and new payload storage. Before EOF no token exists. At and after EOF
   exactly one protocol-owned payload backing store remains, its logical length equals the accepted
   declaration, its backing identity is unchanged, and the same peak bound holds. Empty-payload
   completion allocates no payload buffer.

Each mutant below is an executable derived source variant selected before the isolated oracle
starts. The unchanged oracle must turn red when the mutant:

- allocates or reserves payload capacity in the constructor, on a partial header, or before
  magic, version, length, and bound acceptance;
- allocates from an invalid or oversized declaration;
- clones, calls `to_vec`, repacks, stages a full payload, preserves the old buffer during
  replacement, or copies during `AwaitingEof` or `CompleteFrame` construction;
- replaces or bypasses the production fallible-reservation seam with `Vec::with_capacity`,
  `reserve`, `reserve_exact`, `unwrap`, `expect`, or ignored error handling;
- catches or erases reservation failure, remains in `Payload`, retries reservation, fabricates an
  empty or partial `CompleteFrame`, or exposes semantic identity; or
- panics on reservation failure or terminal-state misuse.

The early-allocation controls observe the first two mutants. Peak capacity and backing identity
observe duplicate or over-budget storage even when logical lengths remain bounded. The injected
accepted-size failure observes a bypassed seam or wrong error path, while `catch_unwind` and the
isolated-process normal exit make panic and abort non-green. `try_reserve_exact` is not treated as
a promise about physical allocator bytes; the oracle measures reported live capacities and limits
its claim to the frozen source, toolchain, allocator, and test tuple.

### 9.2 Deterministic both-stream cancellation ordering

The Windows oracle adds two native-seam controls named
`both_pending_stdout_completes_first` and `both_pending_stderr_completes_first`. After the required
harvest of already-signaled completions, the seam proves stdout and stderr each own exactly one
unsignaled pending read. It records each stream's distinct handle and exact `OVERLAPPED` identity.

At finalization the call trace must contain one matching
`CancelIoEx(stdout_handle, &stdout_overlapped)` and one matching
`CancelIoEx(stderr_handle, &stderr_overlapped)` before the first wait on either stream. There may
be no `WaitForSingleObject`, `WaitForMultipleObjects`, blocking harvest, timer wait, or equivalent
wait boundary between the two exact cancellation calls. Only after both calls are observed does
the seam release terminal completions: stdout then stderr in the first control and stderr then
stdout in the second.

Each control requires one terminal harvest per issued operation, distinct stream state and
artifacts, no read issued after closing begins, no storage or event reuse before its own harvest,
and zero pending operations before response. Completion of the first stream cannot authorize a
response or release the other stream's handle, event, `OVERLAPPED`, or buffer.

The serial `cancel stdout -> wait/harvest stdout -> cancel stderr` mutant fails deterministically
at the instrumented first-wait boundary. Additional mutants omit or duplicate one cancellation,
cancel with the other stream's handle or `OVERLAPPED`, or let first-stream completion release or
terminalize the second stream. The outer watchdog remains the containment backstop and is not the
ordering predicate.

### 9.3 Complete native issue, cancellation, and terminal-harvest matrix

The native-call seam drives the same production issue and terminal-harvest routine with a
table-defined result script. Immediate and pending cases assert exact call count, pending-count
transition, backing ownership, transferred extent, digest and artifact writes, completion facts,
and final complete-versus-incomplete fields.

The issue rows are:

| `ReadFile` issue result | Required adjudication |
| --- | --- |
| Immediate success with positive transferred bytes | Commit exactly that extent once through the common terminal-harvest routine; inspect, hash, and write no unused tail; create no pending operation. |
| Immediate `ERROR_BROKEN_PIPE` | Record authoritative EOF with zero fabricated bytes and no pending operation. |
| Immediate other error | Record the exact typed incomplete-capture fault and create no pending operation. |
| `ERROR_IO_PENDING` | Create exactly one pending operation retaining its handle, event, `OVERLAPPED`, and buffer. An initial `GetOverlappedResult(..., FALSE)` returning `ERROR_IO_INCOMPLETE` leaves ownership and the pending count unchanged; a later terminal harvest is mandatory. |

For the pending row, each cancellation-call class is crossed with each later terminal-harvest
class rather than inferred from it:

| `CancelIoEx` result | Required later harvests and combined result |
| --- | --- |
| Success | Separately harvest positive bytes, `ERROR_BROKEN_PIPE`, `ERROR_OPERATION_ABORTED`, and another error. Success means request accepted only. Raced bytes are committed once and remain an incomplete closing prefix without EOF; broken pipe alone establishes EOF; operation-aborted and other error remain incomplete. |
| `ERROR_NOT_FOUND` | Separately harvest the same four outcomes. The lost issue/cancel race is not completion or EOF; later bytes or broken pipe retain their ordinary meaning, and aborted or other-error completion remains incomplete. |
| Any other cancellation error | Retain the exact cancellation-call fault and separately harvest the same four outcomes. A later success cannot erase that fault. Bytes are committed once; broken pipe may establish EOF as an operation outcome, but the retained cancellation fault keeps the aggregate non-PASS; aborted and other error retain both fault dimensions. |

A successful zero-byte completion and a transferred count outside the buffer extent remain the V3
typed negative outcomes. Every matrix cell reaches exactly one terminal harvest, decrements the
pending count only there, releases storage only afterward, and emits a full-stream hash or
`CompleteEof` only when broken-pipe EOF or separately preregistered natural EOF was actually
harvested.

Coordinated result-dependent mutants activate only after the seam returns the targeted issue,
cancellation, and harvest results. The unchanged table oracle must turn red when a mutant:

- treats `ERROR_IO_INCOMPLETE`, cancellation success, `ERROR_NOT_FOUND`, or another cancellation
  failure as terminal;
- assumes cancellation success can only finish as `ERROR_OPERATION_ABORTED`;
- skips terminal harvest after a non-`ERROR_NOT_FOUND` cancellation failure;
- discards or double-counts bytes that complete after any cancellation result;
- treats post-cancellation broken pipe as non-EOF or `ERROR_OPERATION_ABORTED` as EOF;
- erases a retained cancellation-call fault when the later harvest supplies bytes or EOF;
- creates pending state after an immediate submission error, or bypasses common adjudication for
  an immediate outcome; or
- decrements pending, reuses, or drops a handle, event, `OVERLAPPED`, or buffer before terminal
  harvest.

### 9.4 Independent artifact write, flush, and synchronization adjudication

The Windows artifact oracle uses a native storage seam whose call/result trace is independent of
the evidence object. The cases begin with complete capture, exact retained bytes, no gap or tail,
and unchanged retained-object identity so only durability adjudication varies:

1. **Flush succeeds and synchronization fails.** Full write and flush succeed; the native
   synchronization call returns an injected failure. Evidence must record separate
   write-success, flush-success, and synchronization-failure facts, including the exact bounded
   native error. It retains measured extent and hash but makes no synchronized or durable-artifact
   claim and folds `ERROR/2` under the existing I/O/evidence rule.
2. **Flush fails and synchronization is not attempted.** Full write succeeds and flush returns an
   injected failure. Evidence records the flush failure and an explicit
   `NotAttemptedBecauseFlushFailed` synchronization result. The independent trace proves zero
   synchronization calls. The artifact is non-PASS and folds `ERROR/2`; absence of the call cannot
   be reported as success.
3. **All three stages succeed.** The existing full-write, successful-flush, successful-
   synchronization green remains required and records three independently observed successes.

The fabricated-synchronization-success mutant copies flush success into the synchronization field,
reports success after an injected synchronization failure, or reports success when no
synchronization call occurred. The oracle compares evidence with the independent call count and
native result and turns red. Existing partial-write/error, failed-flush, exact logical-extent and
hash, stable retained identity, no producer pathname reopen, and post-terminal immutability
controls remain required. A successful hash or flush never substitutes for synchronization.

### 9.5 Cumulative gates, folds, ordering, and claim limits

All V1, V2, and V3 controls and mutants remain cumulative. In particular, V4 does not replace the
EOF-only `CompleteFrame` gate, native absolute ingress deadline, private one-instance local
byte-mode named pipes, one issued read per stream, stable overlapped storage, immutable two-cutoff
capture budget, 250-millisecond injected cleanup budget, five-second independent outer watchdog,
nonreturning fail-stop, zero-pending return gate, retained-object evidence, logical/full-stream
separation, post-create phase truth, Job-empty separation, Unix identity controls, Q-152 runtime
closure, or external runner/channel provenance requirements.

The dependency order in §§6.2, 6.13, and 8.9 remains serial and unchanged. The exact registered
runner homes and their exact `Tools/process-supervisor` working directory remain those in §§6.11,
7.1, 8.3, and 8.8; V4 adds no alternate runner. The aggregate status fold remains the maximum
severity in frozen order **PASS/0 < FAIL/1 < ERROR/2 < STRUCTURAL/3**, retaining every lower-level
red. Cargo raw exit 101 is still not canonical FAIL/1. A helper PASS remains only helper lifecycle
evidence; it is never a Q-152 or Cesium product PASS.

The claim limits in §§6.14–6.15 remain exact. Protocol memory controls establish only the narrowly
measured frame-buffer-capacity predicate, not RSS, allocator, decoder, native-ingress, or OS memory
safety. Windows cancellation and durability controls establish behavior only on an independently
certified exact Windows, toolchain, allocator, responsive-kernel, local-pipe, and local-filesystem
tuple. They do not establish hostile-code sandboxing, a general security boundary, hard deadlines
under a wedged kernel, driver, or filesystem, another platform's behavior, standalone attestation,
Q-152 product certification, or supported-user documentation.

The categorical supply-chain NO-GO remains a `STRUCTURAL/3` prerequisite failure for every future
Cargo runner until separately repaired, frozen, and independently approved. Approval of V4 alone
cannot release implementation, execution, certification, documentation, landing, or push.

### 9.6 V4 freeze and fresh independent review

After this append, the author full-reads and freezes the complete file, the immutable 87,821-byte
V3 prefix, the immutable V2 and V1 prefixes inside it, the immutable 28,295-byte V3 suffix, and the
V4 suffix beginning at zero-based byte offset 87,821. The freeze reports byte count, SHA-256,
LF/CR counts, BOM state, terminal-LF state, and the exact V3/V4 boundary. Any prefix drift stops the
lane rather than being repaired in place.

Two entirely fresh independent read-only nonauthors receive the complete exact V4 tuple. Neither
may be Fingolfin, Turgon, Fingon, any V4 author or mapper, any V1–V3 reviewer, or a prospective
implementation, oracle, or execution author.

1. The protocol-memory reviewer re-derives the owned-capacity boundary, actual production-path
   reservation seam, no-premature-allocation controls, accepted-size forced failure, peak bound,
   one-backing-store transfer, allocation observation, panic/abort handling, every memory mutant,
   runner home, fold, dependency order, supply-chain preservation, and every immutable prefix.
2. The Windows reviewer re-derives both deterministic completion orders, exact dual-cancel-before-
   wait trace, the serial-cancellation mutant, the complete issue/cancel/harvest Cartesian matrix,
   result-dependent mutants, independent write/flush/synchronization controls, cumulative V3
   lifecycle/evidence gates, platform and claim limits, supply-chain preservation, and every
   immutable prefix.

Each reviewer full-reads and hashes the complete record and all registered byte ranges at opening
and terminally at close, stops on drift, edits nothing, and performs no Git, Cargo, Rust, Node,
npm, test, build, binary, browser, network, evidence-publication, or external-state action.
Conditional GO is NO-GO. A finding reopens only this record lease; a repair creates a new
append-only tuple and requires two different fresh reviewers. Fingolfin does not self-review or
claim GO. Until both exact-tuple reviews return unconditional GO, this record grants **no
implementation or execution authority**.
