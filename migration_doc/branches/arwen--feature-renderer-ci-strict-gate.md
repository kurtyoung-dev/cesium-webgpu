# Arwen - strict FeatureRenderer audit CI gate

- Date: 2026-08-30
- Status: PREREGISTERED PLAN / IMPLEMENTATION HELD / BASELINE NOT RUN / NO CERTIFICATION CLAIM
- Tier-2 lead: Arwen
- Tier-3 analyst: Eärendil
- Independent tier-3 reviewer: Varda
- Governing context: residual G-3 and Q-44 CI-enforcement debt under R-2026-08-29-1 and R-2026-08-29-3.
- Git authority: root orchestrator only. No push authority is granted.
- Baseline release condition: Varda must read and hash this materialized record and return an unconditional physical-record GO before root executes the first gate.

## 1. Confirmed defect

The guards job in .github/workflows/dev.yml currently executes:

~~~text
npm run audit-feature-renderers
~~~

package.json routes that command to node Tools/audit-feature-renderers.mjs. The audit computes findings in both modes, but the terminal fold is process.exit(strict && hasFindings ? 1 : 0), where strict is true only when --strict reaches the Node process. CI therefore exits zero even when the audit reports findings. Tools/ci-guards.spec.mjs currently requires the advisory command and preserves the defect.

The narrow repair is to make only the CI invocation strict. The no-argument package script remains an intentional local report-only command. No allowlist, finding suppression, de-scoring, or audit-implementation change is authorized.

## 2. Frozen Phase-A identities

| Path | Bytes | SHA-256 | Raw EOL |
| --- | ---: | --- | --- |
| .github/workflows/dev.yml | 9,033 | AD7A2BB39923F2715A1BEE91C37B429BF987FBED3A3691A7793F8928A3C5DBF9 | 208 CRLF; zero bare LF/CR; no BOM; terminal LF |
| Tools/ci-guards.spec.mjs | 6,832 | 6011D12754EDB4C346CEC6D716C7B69BAE5428E8441CE4C5A802C579049DC438 | 206 LF; zero CR; no BOM; terminal LF |
| Tools/audit-feature-renderers.mjs | 7,093 | 43474E288B71B466D1261F4065C27A691485A97360E2C977A798BDCA6483718E | 201 CRLF; zero bare LF/CR; no BOM; terminal LF |
| package.json | 10,694 | 2A6F6460C7E9F96A03ED1BE4B6D3920033956AC9A3F378398A1ADD7AD30D9D0D | 223 LF; zero CR; no BOM; terminal LF |

This record path was absent during Phase A:

~~~text
migration_doc/branches/arwen--feature-renderer-ci-strict-gate.md
~~~

A read-only branch-record search found no record naming either writable code path. Phase A expressly prohibited Git, so this is not a tracked-versus-dirty or active-lease proof. Root must collision-check current Git state and active leases before materialization and again before Phase-B edits. Any preimage drift stops the lane and requires a new preregistration.

## 3. Path ownership

The record-creation step may create only:

- migration_doc/branches/arwen--feature-renderer-ci-strict-gate.md

After an eligible exit-zero baseline is banked, the Phase-B writable lease may open only:

- .github/workflows/dev.yml
- Tools/ci-guards.spec.mjs
- migration_doc/branches/arwen--feature-renderer-ci-strict-gate.md

Read-only collision sentries and excluded production paths:

- Tools/audit-feature-renderers.mjs
- package.json
- every packages/engine/Source path
- every other workflow, tool, spec, hook, queue, ledger, generated output, and evidence path

Workers have no Git, build, browser, network, dependency-installation, publication, server, or process-management authority. Root owns every Git action and every executable gate.

## 4. First-gate transitive input manifest

The audit recursively reads the live packages/engine/Source JavaScript and TypeScript fleet. The baseline is eligible only when that complete input set is stable around the command.

Root must construct a pre-run and post-run canonical manifest with this exact algorithm:

1. Use F:/Dev/GH/cesium-webgpu as the repository root.
2. Recursively walk packages/engine/Source without following symbolic links, junctions, or other reparse points. Encountering one inside the traversed tree is STRUCTURAL and stops the run.
3. Include every regular file whose name ends case-sensitively in .js or .ts. This includes .d.ts. Include no other extension.
4. Express each path relative to the repository root with forward slashes. A path containing a tab, CR, or LF is STRUCTURAL.
5. Read raw bytes without decoding or EOL normalization. For each file compute its decimal byte length and uppercase SHA-256.
6. Sort entries by ordinal comparison of the UTF-8 bytes of the forward-slash relative path. Do not use locale-aware or case-folded sorting.
7. Encode one canonical line per entry as path, one tab, decimal byte length, one tab, uppercase SHA-256, then one LF:
   path\tbytes\tSHA256\n
8. Concatenate the lines as UTF-8 without BOM. The record is LF-only and has exactly one terminal LF when at least one entry exists.
9. Record the tuple: entry count, sum of raw file bytes, canonical-record byte length, and uppercase SHA-256 of the complete canonical record.

The pre-run and post-run tuples must be exactly identical, and root must retain enough of both canonical records to prove byte equality rather than merely restating the tuple. Tools/audit-feature-renderers.mjs and package.json must also retain the exact identities in section 2 before and after the command. A changed membership, path, byte count, file digest, aggregate digest, audit witness, or package witness makes the run ineligible to unlock implementation.

Input drift never erases an observed red. Root banks the raw outcome and the drift together, marks the attempt ineligible/STRUCTURAL, and stops.

## 5. First executable gate

Only after this physical record receives Varda's unconditional GO, root runs exactly:

- Working directory: F:/Dev/GH/cesium-webgpu
- Command:

~~~text
npm run audit-feature-renderers -- --strict
~~~

This is the first executable gate. Root records the literal command, working directory, start/end time, raw exit or signal, stdout and stderr bytes plus their SHA-256 identities, the pre/post manifest tuples, the two witness rehashes, and a bounded observation that the npm/Node command and its descendants exited.

Outcome fold:

| Observed outcome | Disposition |
| --- | --- |
| Exit 0, exact pre/post input identity, witnesses exact, no surviving child | Eligible clean baseline. Bank the receipt; only then may Phase B open. This is not certification. |
| Exit 1 | Valid feature-renderer debt/FAIL. Bank every finding and stop. Do not arm knowingly red CI, add an allowance, or change the scoring subject. |
| Exit 2 | Audit/runtime ERROR. Bank stdout/stderr and stop. |
| Any other numeric exit, signal, spawn failure, timeout, or missing receipt field | Bank the raw outcome as ERROR or STRUCTURAL according to the observed cause and stop; do not remap it to PASS. |
| Any pre/post or witness drift | Bank the command outcome plus drift, mark the attempt ineligible/STRUCTURAL, and stop. An accompanying exit-1 red remains visible. |

No second invocation occurs until the complete prior attempt is appended to this record. A red is never demoted, quarantined, or omitted.

## 6. Implementation patch held behind the baseline

No implementation byte is authorized before an eligible exit-zero baseline.

Held workflow patch:

~~~diff
       - name: audit feature renderers
-        run: npm run audit-feature-renderers
+        run: npm run audit-feature-renderers -- --strict
~~~

Held Tools/ci-guards.spec.mjs obligations:

1. Define the canonical strict command and the advisory command separately.
2. Put the canonical strict command in WIRED_GUARDS.
3. Parse an npm script name with /^npm run ([^\s]+)(?:\s|$)/ so forwarded argv is not mistaken for part of the package-script name.
4. Derive the guards-job run strings from parsed YAML.
5. Require exactly one audit-feature-renderers run and require it to equal the canonical strict command byte-for-byte.
6. Clone the live run-string list in memory, replace exactly the strict command with the advisory command, prove the mutant changed, and require the contract to throw.
7. Copy the unchanged audit CLI into an OS-temporary synthetic repository rooted by the copied script's own import.meta.url. Create only synthetic packages/engine/Source inputs and invoke with process.execPath, fixture-root cwd, a bounded timeout, immediate cleanup registration, and assertions over spawn error, signal, status, stdout, and stderr.
8. Preserve the existing advisory package.json command and leave Tools/audit-feature-renderers.mjs byte-identical.

The copied CLI is a valid existing hermetic seam because the audit derives ROOT from its own module URL. Temporary fixture files are test scratch, not production-path additions.

## 7. Registered controls and mutants

Parsed-workflow command contract:

- Positive: exactly one npm run audit-feature-renderers -- --strict.
- Remove-strict mutant: replace that command with npm run audit-feature-renderers; the contract must throw.
- Missing-command mutant: remove the audit run; the contract must throw.
- Duplicate-command mutant: add a second audit run; the contract must throw.
- Extra-argv mutant: append any token; the exact contract must throw.
- Chained-command mutant: append a shell operator and command; the exact contract must throw.
- Quoted or otherwise textually alternate spelling: rejected even if a shell might produce similar argv; CI has one canonical spelling.
- Parser control: the strict command resolves to package script name audit-feature-renderers, not audit-feature-renderers -- --strict.

Hermetic observable CLI controls:

- One enum key with one registration and one consumer, strict mode: exit 0 and No findings.
- Add one named ORPHAN enum key with no registration or consumer, advisory mode: finding remains visible and exit 0.
- The same ORPHAN fixture, strict mode: the same finding remains visible and exit 1.
- Remove the required FeatureRendererKey.js fixture, strict mode: exit 2 with a required-source read error.

The final test must not mutate any real engine source or import the real audit module in place. The audit runs only as the copied child CLI against the temporary synthetic tree.

## 8. Post-baseline validation and freeze

After an eligible baseline and implementation:

1. Rehash all three leased paths and both excluded witnesses.
2. Run node --test Tools/ci-guards.spec.mjs. Expected topology: 9 tests, 9 pass, zero fail/cancelled/skipped/todo.
3. Bank the registered in-memory remove-strict mutation and all hermetic CLI outcomes.
4. Run npm run test-build-infra from a current isolated candidate. Expected exit 0; record the actual test topology.
5. Re-run npm run audit-feature-renderers -- --strict with the same transitive pre/post input-manifest rule. Expected exit 0.
6. Run exact-path formatting/whitespace checks and the documentation-integrity guard required for the new record. A migration_doc Prettier command is not accepted if .prettierignore makes it vacuous.
7. Freeze each leased path by byte length, SHA-256, raw EOL counts, and terminal newline state.
8. Give the exact frozen tuple and raw outputs to an independent read-only reviewer. Any byte drift or required finding reopens the lane.

No build or browser gate is required for this tool/workflow-only change. A later authorized push must provide the first hosted Actions observation; until then Q-44's hosted evidence remains owed.

## 9. Claim limits and carry-forward

This lane may claim only:

- the current-tree strict baseline outcome bound to stable inputs;
- parsed dev.yml configuration contains exactly the canonical strict command;
- removing strictness is detected;
- the unchanged CLI demonstrates clean 0, advisory-finding 0, strict-finding 1, and missing-required-source 2 against synthetic inputs;
- package.json preserves the local advisory route.

This lane may not claim:

- hosted GitHub Actions execution or success;
- broad correctness or completeness of the feature-renderer audit;
- engine, renderer, shader, build, browser, GPU, pixel, or cross-backend behavior;
- malformed-syntax detection;
- unknown-argument rejection;
- certification of any kind.

Important carry-forward: syntactically empty, nonsensical, or otherwise structurally malformed FeatureRendererKey.js content is not currently validated and may produce zero parsed keys with exit 0. Missing-required-source exit 2 is a runtime/input-error control, not malformed-syntax handling. Repairing that limitation would require a separately preregistered Tools/audit-feature-renderers.mjs lane and must not be smuggled into this patch.

The existing intentional-unwired-key policy is outside scope. No entry is added, removed, reinterpreted, or used to excuse a first-gate finding.

## 10. Named verdict history

- Eärendil independently re-read the current files, confirmed the advisory-CI defect and exact Phase-A identities, proposed the narrow workflow/spec repair, and returned GO to create a preregistration but NO-GO to implementation before a clean strict baseline.
- Eärendil initially classified relocation of the CLI as scope expansion. That single plan point is superseded, not silently omitted.
- Varda independently confirmed the defect, hashes, collision boundary, advisory local route, npm forwarding semantics, and need for the remove-strict mutant. Varda showed that copying the unchanged location-relative CLI to an OS-temporary synthetic root is an existing hermetic seam.
- Arwen adopted Varda's correction, narrowed exit-2 language to missing-required-source runtime/input error, added the complete transitive input manifest, and retained malformed syntax as explicit unverified debt.
- Varda then returned an unconditional terminal GO for this corrected plan, limited to materializing the preregistration and releasing only the first root-owned strict gate. That verdict approved a plan, not uncreated bytes.
- After root materializes this file, Varda must read the complete physical record, verify its byte identity and governance content, and return a fresh unconditional physical-record GO. Until that report arrives, the strict baseline remains NOT AUTHORIZED.

## 11. Strict-baseline attempt A1 - banked ERROR

Attempt A1 is the first root-owned baseline attempt under this preregistration. It produced no product measurement because the Windows launcher mechanism failed before any audit child existed.

| Field | Banked value |
| --- | --- |
| Command claim | npm run audit-feature-renderers -- --strict |
| Working directory | F:\Dev\GH\cesium-webgpu |
| Wrapper start | 2026-08-30T17:36:15.209Z |
| Wrapper end | 2026-08-30T17:36:15.219Z |
| Monotonic duration | 7,234,927 ns |
| Child PID | 0 - never launched |
| Child status | null |
| Child signal | null |
| Spawn error | name Error; code EINVAL; message spawnSync npm.cmd EINVAL |
| Governed disposition | ERROR / ineligible / no product measurement / Phase B remains held |

The wrapper attempted a direct npm.cmd spawn. Windows rejected that launcher shape with EINVAL before npm, the package script, or Tools/audit-feature-renderers.mjs began. This is a launcher-mechanism error, not a feature-renderer finding, PASS, FAIL, or audit exit.

Raw streams:

| Stream | Bytes | SHA-256 |
| --- | ---: | --- |
| stdout | 0 | E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855 |
| stderr | 0 | E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855 |

The pre-run and post-run engine manifests were byte-identical:

| Manifest field | Pre-run | Post-run |
| --- | ---: | ---: |
| Entry count | 2,152 | 2,152 |
| Raw-file byte sum | 27,789,253 | 27,789,253 |
| Canonical-record bytes | 278,241 | 278,241 |
| Canonical-record SHA-256 | C7F744CA70F4264F417B4F1C414354206EDC7AED4C2C4468968267BC89D54B20 | C7F744CA70F4264F417B4F1C414354206EDC7AED4C2C4468968267BC89D54B20 |

Direct Buffer.equals comparison returned true and there was no first differing byte. The four preregistered witnesses also remained exact before and after A1:

| Witness | Bytes | SHA-256 |
| --- | ---: | --- |
| .github/workflows/dev.yml | 9,033 | AD7A2BB39923F2715A1BEE91C37B429BF987FBED3A3691A7793F8928A3C5DBF9 |
| Tools/ci-guards.spec.mjs | 6,832 | 6011D12754EDB4C346CEC6D716C7B69BAE5428E8441CE4C5A802C579049DC438 |
| Tools/audit-feature-renderers.mjs | 7,093 | 43474E288B71B466D1261F4065C27A691485A97360E2C977A798BDCA6483718E |
| package.json | 10,694 | 2A6F6460C7E9F96A03ED1BE4B6D3920033956AC9A3F378398A1ADD7AD30D9D0D |

The bounded pre-census and post-census, each excluding its own census process, were both the empty array ([]). No audit child or session existed, and no audit process survived because none launched.

A1 is now retained append-only. No rerun occurred before this bank. Any later retry requires a separately reviewed corrected Windows launch shape that still invokes the exact command claim and preserves the complete manifest/witness protocol. This record does not authorize that retry, and no later result may erase, replace, de-score, or omit A1.

## 12. Pre-A1 physical authority history and status clarification

Before the A1 wrapper start at 2026-08-30T17:36:15.209Z, Varda independently read the complete physical preregistration record and recomputed this exact identity:

| Field | Pre-A1 physical value |
| --- | ---: |
| Bytes | 13,960 |
| SHA-256 | 91DC9AF515DFE7B1E67114795D6B3CE46802BB6B9BEB7B278E7331F4CAEFEF0A |

Varda also confirmed that all four sentries remained exact at the frozen identities in section 2:

| Sentry | Bytes | SHA-256 |
| --- | ---: | --- |
| .github/workflows/dev.yml | 9,033 | AD7A2BB39923F2715A1BEE91C37B429BF987FBED3A3691A7793F8928A3C5DBF9 |
| Tools/ci-guards.spec.mjs | 6,832 | 6011D12754EDB4C346CEC6D716C7B69BAE5428E8441CE4C5A802C579049DC438 |
| Tools/audit-feature-renderers.mjs | 7,093 | 43474E288B71B466D1261F4065C27A691485A97360E2C977A798BDCA6483718E |
| package.json | 10,694 | 2A6F6460C7E9F96A03ED1BE4B6D3920033956AC9A3F378398A1ADD7AD30D9D0D |

Varda returned unconditional physical-record GO with no required findings and no live child or session. That delivered verdict superseded line 200's pending-GO and not-authorized state before A1 began. This section is a durable transcription of authority that existed before A1; it is not retroactive authorization.

The GO released only the first root-owned strict baseline gate. It did not authorize Phase B implementation or certify the feature-renderer inventory. It also does not authorize a retry after A1.

The header's `BASELINE NOT RUN` status means that no eligible audit or product measurement has been obtained. A1 remains a banked launcher ERROR attempt: its wrapper ran, but no audit child launched and no product verdict exists.

## 13. A2 corrected Windows launcher design - freeze incomplete / execution held

This section records a bounded replacement design after the rejected A2 payload. It does not authorize A2, alter or erase A1, release Phase B, or make a product claim. A1 remains the retained launcher ERROR in section 11. Every item marked `UNFROZEN` is a hard prerequisite, not an optional evidence field; this design cannot become run authority until those values are appended, independently reviewed, and separately released by root.

### Selected boundary

Shape A remains the only candidate: an independently certified native supervisor must launch the exact Node executable directly with typed argv. No Node, PowerShell, cmd, npm shim, PATH search, or interpolated command string may sit between the supervisor and the root Node/npm process.

The root child specification remains:

- Executable: `C:\Program Files\nodejs\node.exe`, 86,997,320 bytes, SHA-256 `0D0F5E39F9F3D9587BC19F73EAB3C2C9C4903FD02D6DBF9C853DD81B3D95FAD4`, file/product version 22.23.2.
- Argv, exactly and in order: `C:\Users\Kurt\AppData\Roaming\npm\node_modules\npm\bin\npm-cli.js`, `run`, `audit-feature-renderers`, `--`, `--strict`.
- Working directory: `F:\Dev\GH\cesium-webgpu`.
- Logical command claim: `npm run audit-feature-renderers -- --strict`.
- Shell: false; no `argv0`, joined string, shim, fallback, interpolation, or inherited environment.
- Raw stdout and stderr: separate byte streams, 16,777,216-byte cap per stream, no decoding before byte count/SHA-256/retention.
- Timeout: 120,000 milliseconds; any timeout is ERROR and triggers governed whole-tree cleanup/census, never a product result or retry.

The selected npm CLI remains the shim-equivalent roaming npm 11.4.1 tree, not the colocated npm 10.9.8 tree. Its frozen tuple remains 2,311 regular files, 11,782,463 raw bytes, 264,445 canonical-record bytes, and SHA-256 `334F0424A0FDF83E955E863AEECD03D5CC7AE616146AE3EB77B544A4D378C15F`, with zero reparse points and no non-ASCII/tab/CR/LF paths. The complete npm-tree manifest and all launcher/config identities from the rejected review must be exact before and after A2.

Shape B remains NO-GO. Invoking `C:\Windows\System32\cmd.exe /d /s /c` around bare `npm run audit-feature-renderers -- --strict` adds outer command parsing, current-directory/PATH/PATHEXT selection, two possible npm shims, prefix redirection, and another exit-propagation boundary without improving the product subject.

### Frozen pre-Node TCB required

The native supervisor is the complete pre-Node launch TCB. Its executable absolute path, raw bytes, SHA-256, source-manifest identity, certification receipt, request-schema version, exact invocation argv, and exact request bytes/SHA-256 are `UNFROZEN`. No ad-hoc JS or PowerShell wrapper may substitute for it.

Before this lane can request A2 authority, an independent certification must establish on this Windows host tuple that the exact supervisor build:

1. invokes the absolute executable with the exact ordered argv and cwd without a shell;
2. replaces, rather than merges, the child environment and cannot inherit `NODE_OPTIONS`, `NODE_PATH`, duplicate-case Windows environment entries, prompt text, or ambient `NPM_*` values;
3. captures separate raw stdout/stderr without treating child bytes as control input;
4. enforces the 120,000-millisecond timeout and 16,777,216-byte per-stream caps;
5. contains and observes the complete descendant tree, retaining kernel-bound creation and exit records with PID, parent PID, creation identity, image path, command line, exit status/signal, and image hash;
6. proves terminal quiescence or returns ERROR/STRUCTURAL, with no child or handle surviving supervisor completion;
7. never retries automatically.

The exact supervisor tuple and request are minimal new frozen inputs. Until they exist and receive independent GO, A2 is NOT AUTHORIZED.

### Exact replacement child environment

The supervisor must construct a replacement environment containing only the following 32 entries. Keys are sorted by ordinal UTF-8 bytes and encoded exactly as `name=value\n`, UTF-8 without BOM:

~~~text
APPDATA=C:\Users\Kurt\AppData\Roaming
CI=1
ComSpec=C:\Windows\System32\cmd.exe
FORCE_COLOR=0
HOMEDRIVE=C:
HOMEPATH=\Users\Kurt
LOCALAPPDATA=C:\Users\Kurt\AppData\Local
NO_COLOR=1
NoDefaultCurrentDirectoryInExePath=1
PATH=C:\Program Files\nodejs;C:\Windows\System32;C:\Windows
PATHEXT=.EXE
PROCESSOR_ARCHITECTURE=AMD64
SystemDrive=C:
SystemRoot=C:\WINDOWS
TEMP=C:\Users\Kurt\AppData\Local\Temp\cesium-webgpu-arwen-feature-renderer-a2\tmp
TMP=C:\Users\Kurt\AppData\Local\Temp\cesium-webgpu-arwen-feature-renderer-a2\tmp
USERNAME=Kurt
USERPROFILE=C:\Users\Kurt
WINDIR=C:\WINDOWS
npm_config_audit=false
npm_config_cache=C:\Users\Kurt\AppData\Local\Temp\cesium-webgpu-arwen-feature-renderer-a2\cache
npm_config_color=false
npm_config_fund=false
npm_config_globalconfig=C:\Users\Kurt\AppData\Roaming\npm\etc\npmrc
npm_config_ignore_scripts=false
npm_config_loglevel=notice
npm_config_offline=true
npm_config_prefix=C:\Users\Kurt\AppData\Roaming\npm
npm_config_progress=false
npm_config_script_shell=C:\Windows\System32\cmd.exe
npm_config_update_notifier=false
npm_config_userconfig=C:\Users\Kurt\.npmrc
~~~

The canonical record is 32 entries, 1,097 bytes, SHA-256 `DAD0DA9201094015B46DB97EEDEC7442F737ED853AB771F26C432C0927153415`. `PATHEXT=.EXE` narrows the inner package script's bare `node` search; `NoDefaultCurrentDirectoryInExePath=1` removes the default cwd search. A mutant that restores any other PATHEXT extension, omits the current-directory control, merges one ambient entry, or changes one byte must be rejected before spawn.

### Exact inner Node search domain required

The selected npm tree still constructs the package-script PATH internally. The exact source files that define npm 11.4.1 `binPaths` and `@npmcli/run-script` PATH construction, plus the fully derived directory list in exact order for this cwd/config/environment, are `UNFROZEN`. Do not infer the list from npm convention or a package-tree hash.

Before A2 can be authorized, append and independently review:

- each responsible source path, byte count, and SHA-256;
- the exact effective PATH directory list in order;
- each directory's present/absent state, resolved path, and complete ancestor reparse proof;
- a pre/post census for an extensionless `node` and `node.exe` in the repository root and every effective search directory;
- proof that the first and only resolvable executable is `C:\Program Files\nodejs\node.exe` at its frozen hash.

A runtime process-chain receipt must independently show that the package-script descendant image is that same Node executable and that its argv names `Tools\audit-feature-renderers.mjs` followed by exactly `--strict`. Any effective-PATH mismatch, shadow, alternate image, missing child, or extra executable is STRUCTURAL and cannot become a product result. Required mutants introduce `node.exe` before the approved directory, restore `.COM`/`.CMD`/`.BAT`/`.JS` to PATHEXT, add an extensionless `node`, reorder a PATH directory, remove the current-directory control, or substitute the other npm tree.

### Lane-private npm state

The lane-private scratch root is exactly `C:\Users\Kurt\AppData\Local\Temp\cesium-webgpu-arwen-feature-renderer-a2`. It must be absent before preparation. Its existing parent chain through `C:\Users\Kurt\AppData\Local\Temp` must be frozen by resolved path and reparse state; those values are `UNFROZEN`. A present scratch root, reparse hop, alias, or unverifiable ancestor is STRUCTURAL and stops before spawn. No deletion or reuse is authorized.

After the scratch root is created, `cache` and `tmp` must be ordinary empty directories. Each has the empty pre-manifest tuple: zero entries, zero raw bytes, zero canonical bytes, SHA-256 `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855`. The manifest includes every regular file recursively, rejects reparse points and control-character paths, sorts forward-slash relative paths by ordinal UTF-8 bytes, and encodes `path\tbytes\tUPPERCASE_SHA256\n`.

After A2, retain complete cache and tmp canonical manifests and raw tuples, even on FAIL, ERROR, STRUCTURAL, timeout, or output overflow. Their mutation is banked tool state, not product input and not evidence to erase a red. The scratch root remains retained until the attempt and independent review are complete; this section grants no cleanup authority.

### Descendant provenance and governed fold

A2 is eligible only if the supervisor's kernel-bound receipt proves exactly one coherent chain:

1. supervisor to the pinned Node/npm CLI with the exact root argv;
2. that npm process to `C:\Windows\System32\cmd.exe`, 289,792 bytes, SHA-256 `BADF4752413CB0CBDC03FB95820CA167F0CDC63B597CCDB5EF43111180E088B0`, hosting only the frozen package script;
3. that cmd process to the pinned Node executable with audit argv `Tools\audit-feature-renderers.mjs`, `--strict`;
4. no additional descendant executable;
5. audit exit, cmd exit, npm exit, and supervisor-reported root status identical; and
6. every descendant exited with a final empty job/census.

Only the proven audit-descendant exit is folded as the product/tool outcome: 0 is an eligible clean baseline only when every other prerequisite and postcondition is exact; 1 is a visible feature-renderer FAIL; 2 is audit/runtime ERROR. If the audit descendant, its exact argv/image, any creation/exit record, or status propagation is missing or inconsistent, the npm status is only an ineligible command/runtime observation and must fold to ERROR or STRUCTURAL rather than a feature-renderer claim. A spawn failure, timeout, signal, output overflow, helper failure, survivor, or missing receipt is ERROR/STRUCTURAL. Input drift never hides a valid observed red.

Pre-census and post-census rows remain raw and PID-sorted with PID, parent PID, creation identity, executable path, and command line. The engine manifest must equal A1's tuple before launch and remain byte-identical afterward. All four repository sentries, the complete npm tree, every present launcher/config file, the supervisor/request tuple, effective PATH/search sentries, scratch-parent proof, and child environment must be exact before and after. The configured global npmrc `C:\Users\Kurt\AppData\Roaming\npm\etc\npmrc` is separately required to remain absent; it is not described as a present file. The selected npm root, every present named file, cwd, scratch-parent chain, and every effective search-directory ancestor chain must have no reparse hop.

### Controls and release boundary

Pure launch-spec controls must reject argv removal/reorder/append/join, command metacharacters, shell enablement, cwd drift, environment merge/drift, alternate npm or Node identities, supervisor/request drift, PATH/PATHEXT/current-directory mutants, cache reuse/reparse, missing process events, mismatched exit propagation, command-shaped captured output used as control, and any automatic retry. Rejected mutants must make zero product-child launches. The exact positive request must produce one root launch only.

No second invocation occurs until A2 is completely banked. This design is not run authority. Root may append it only under separate edit authority; doing so still leaves every `UNFROZEN` field as a blocker. After all new inputs are physically appended, an independent reviewer must read and rehash the complete record, supervisor/request/certification tuple, npm PATH derivation, and scratch preconditions, then return an unconditional GO limited to root deciding whether to authorize one A2 attempt. Until that later freeze, review, and separate root authorization, A2 and Phase B remain NOT AUTHORIZED.
