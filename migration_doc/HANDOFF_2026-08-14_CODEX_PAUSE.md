# Campaign handoff — 2026-08-14 pause

Paused by maintainer request at **2026-08-14T23:49:21Z**
(2026-08-14 19:49 EDT). No agent should resume edits, tests, builds, browser
runs, evidence publication, staging, or commits until the maintainer says
**go**.

> **Tracking stamp — added 2026-08-14 (fix SOL-1 of
> [SOL_WEEK_AUDIT_2026-08-14.md](SOL_WEEK_AUDIT_2026-08-14.md)).** This file and
> [FINDING_DISPOSITIONS_2026-08-13.json](FINDING_DISPOSITIONS_2026-08-13.json) were
> **untracked** and were the sole record of 36 landings; they are now brought under
> version control. Two corrections are applied in place with the original values
> preserved (§3 path label). The audit is the evidence authority for the
> `cff0b76a2f..034c7f74d0` range because **all 98 commit bodies in it are empty** —
> re-verified 98/98 at this stamp — so no commit message carries a claim. The audit
> also records open findings against this document's subject matter that this stamp
> does not resolve: S7 (the three 18:45–18:47 tip commits were landed against a tree
> whose build had been deleted at 18:26, and the main tree measures the CUSTOM v7 spec
> at 201/204), S11 (three undeclared loosenings in the v7 hardening), and S16 (the
> stale schema stamp refreshed in `DEFERRED_WORK.md`). The §3 gate counts below are
> Sol's own record from the detached certification tree and are **reproduced, not
> re-verified**.
>
> **Scope note added at the same stamp:** a **third** untracked ledger file of the same
> class exists and is NOT named in the audit's SOL-1 —
> `migration_doc/HANDOFF_2026-08-10_CODEX_USAGE_STOP.md` (919 lines, the 2026-08-10
> usage-stop handoff plus its 2026-08-11 portfolio-wave continuation, carrying the
> 25-bucket landing partition and the retained `C11-169` harness-red hashes). It is left
> untracked here because SOL-1 scopes two files; tracking it is a maintainer/orchestrator
> call, and it is recorded so the gap is not rediscovered as new.

## 1. Exact pause boundary

- Primary worktree: `F:\Dev\GH\cesium-webgpu`
- HEAD: `034c7f74d05df64e7dc488cc6a8ce6ca52598083`
- Index: empty; none of the paused work is staged.
- Ports `8080` and `8081`: closed.
- Certification worktree:
  `F:\Dev\GH\cesium-webgpu-cert-s5-3cbb82885fc7`
- All three active subagents were explicitly interrupted before this snapshot:
  - `/root/harden_c12_11_star_catalog`
  - `/root/harden_c12_31_core`
  - `/root/repair_nasa_svs_v5_r2`
- The shared worktree contains substantial unrelated user/agent work. Do not
  clean, reset, stash, reformat, or bulk-stage it. Resume with path-scoped
  status/hash checks.
- A lightweight `node --check` passed on all nine paused campaign files at the
  boundary. This is only a syntax checkpoint; the NASA and C12-31 repairs are
  mid-edit and are not frozen or reviewed.

## 2. Campaign work already landed

The following reviewed waves are in HEAD and must not be reimplemented:

| Commit | Result |
| --- | --- |
| `3cbb82885f` | Transactional viewport/camera/frustum/uniform restoration after 2D/WebVR render failures, including nested/reentrant failure behavior. |
| `a03370f19a` | WebGPU dependent render targets now refresh on current HDR/MSAA tuple changes. |
| `b7d65fbab9` | Private named-only `ViewTemporalHistory` is excluded from generated public default-export barrels; clean build restored without inventing a public API. |
| `8bc01a70ef` | NASA fixture byte identities preserved across checkout line-ending behavior. |
| `92b34e93c9` → `5fb5e5c3fa` | CUSTOM Moon construction, lifecycle/error aggregation, v6 migration, cleanup, and early WebGPU scene-capture ordering repairs. |
| `795e6267bc` | G3 celestial certification hardened: all-backend 4096 preflight barrier, browser-safe ownership helper, exact six-face active-source fingerprint, applied camera basis, lifecycle/VRAM proof, and fail-closed STRUCTURAL precedence. |
| `be8644f0cb` | C12-33 moon mip-motion certification contract/finalizer landed. |
| `034c7f74d0` | CUSTOM v7 certification hardening landed: owned no-autostart harness, exact request epoch, current-frame WebGPU readiness, coherent antipode semantics, real pick readiness, served `Ellipsoid` identity, and strict predecessor handling. |

The broader landed celestial/S5 sequence is preserved in Git. The exact recent
history, newest first, is:

```text
034c7f74d0 Harden custom ellipsoid certification
be8644f0cb Certify moon mip motion evidence
795e6267bc Harden G3 celestial certification
5fb5e5c3fa Enable custom WebGPU capture before instrumentation
55b67a169b Assert nested custom cleanup diagnostics
faa36a5376 Harden custom ellipsoid evidence lifecycle
92b34e93c9 Construct Moon in custom ellipsoid probe
8bc01a70ef Preserve NASA fixture byte identities
b7d65fbab9 Keep temporal history out of public barrels
a03370f19a Refresh WebGPU dependent render targets
3cbb82885f Restore viewport state after render failures
314cbd7140 Reconcile landed S5 evidence status
cd656255e9 Bind S5 evidence to shared ephemeris samples
0670179b7e Assign Aurora and space-weather follow-up owners
bc438639ad Validate Astronomy Engine lazy import by module edge
b31529a0c0 Use shared high-precision ephemeris in Eclipse Explorer
545e13b409 Reconcile landed ephemeris and CPU accounting status
c06699a535 Share celestial ephemeris samples per frame
c404c3de04 Land whole-scene CPU accounting
cc2a938f19 Reconcile eclipse deferred work
38308265d3 Adopt IAU nominal solar radius
f4408cade7 Add local eclipse circumstances solver
15d71de0f3 Add opt-in celestial ephemeris providers
e28caf04a8 Add S5 multiview certification gate
9def755e43 Pin high precision eclipse ephemeris dependency
bc5aa1fda4 Make temporal history view-owned
a791ee5a18 Harden custom ellipsoid evidence lifecycle
6b4ea1464e Assign eclipse space weather queue owners
3664031397 Add Sandcastle2 eclipse explorer
0ba2041e0a Isolate WebGL eclipse replay carriers
39cdab4c2e Add S5 replacement device certification gate
1add9928a4 Harden S5 dense cost evidence
23919f0414 Harden NASA eclipse footprint evidence
8187671047 Fix custom ellipsoid browser uniform proof
84ca631ed6 Harden terrain evidence runtime ledgers
99abefdc26 Add S5 custom ellipsoid certification gate
53a9f4b52d Harden S5 terrain fill evidence lifecycle
820bff13af Fix synchronous heightmap vertex count
ae37cea5c7 Add NASA SVS eclipse footprint evidence
fb8a4b6f1b Harden S5 terrain selection evidence
44b63910e9 Add S5 dense active inactive cost gate
2d211e34ca Add S5 terrain fill failure observability
9e576b0a42 Stabilize S5 terrain fill certification
e677612f82 Certify S5 terrain fill at a live selection frontier
32acf69dd1 Derive S5 terrain fill target from live selection
```

## 3. Clean-build and static certification already completed

The detached certification tree was advanced to `034c7f74d0`, cleaned, and
built with:

```text
npm run build -- --sourcemap --no-node
```

Result: PASS, exit 0, 91.4 seconds. The cert worktree remained tracked-clean.

Generated identities from that build:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `Build/CesiumUnminified/index.js` | 22,351,948 | `9A95372845B01CDC9A9865A7B1A96D5193AD953BEE6EEDD67E1B282DCAC7E48E` |
| `Build/CesiumUnminified/index.js.map` | 40,632,008 | `17387E0FBC9C516CD03640090096379FB7996EF2F214E28F7B635699B2EC3979` |
| `Build/CesiumUnminified/Cesium.js` | 27,475,038 | `DD6BA22B59860F81583A2631B6A19F04618E029B756A1FC4C2DBA1860D456301` |
| `Build/CesiumUnminified/Cesium.js.map` | 44,751,177 | `D701A8EBD683B2E32D16589450EDF5C8643528CD7277B014382E755ECE972D90` |

_Path-label correction, 2026-08-14 (`SOL_WEEK_AUDIT_2026-08-14.md`, Lane E claim 20 /
fix SOL-1). The last two rows originally read `Build/Cesium/`. `npm run build --
--sourcemap --no-node` writes the unminified variant only, so both artifacts live under
`Build/CesiumUnminified/`. **Only the label changed** — the byte counts and hashes are
reproduced verbatim and were NOT re-verified (that build was deleted before this
correction). A 27 MB `Cesium.js` is the unminified IIFE — the minified dual build is
~7.1 MB — which is the independent check that the path label, not the measurement, was
the error._

Authoritative clean-tree static gates at this HEAD:

- G3: **105/105 PASS**
- C12-33 combined contract/finalizer: **34/34 PASS**
- CUSTOM v7: **204/204 PASS**
- Existing G1 + sky-light-direction baselines: **86/86 PASS**

This build predates the three paused packets below. It is an early regression
baseline, not the final certification build.

## 4. Paused packet A — NASA/SVS v5 repair

Owner to resume: `/root/repair_nasa_svs_v5_r2`

Status: **mid-repair; syntax-clean; not frozen; no independent re-review yet**.

Current exact bytes at pause:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Tools/visual-regression/lib/c12-29-s5-svs-footprint-gate.mjs` | 185,201 | `696BC826B99DCBDF3CE874CF84947C6B38CAD1CFC894DE3CC4DF6F0F51964B13` |
| `Tools/visual-regression/probe-c12-29-s5-svs-footprint.mjs` | 179,432 | `A145C420FE4F75E23A647DF31EF4D38BF180878F07B7634F08975D199E7ED41D` |
| `Tools/visual-regression/c12-29-s5-svs-footprint-gate.spec.mjs` | 186,738 | `D5D4A41638AC4CB0599FF0C3561023A7B2FFCB250EA2DCA19E9C3B6CC28BBD53` |

Independent review had rejected the prior v5 candidate for, among other
things:

- schema laundering of incoming v3/v4 diagnostics;
- foreign-latest loss during initial prior claim;
- unfrozen camera FOV/height and derived footprint;
- noneclipse control physics not proving a noneclipse;
- projected-cell-to-pixel correspondence accepted when jointly forged;
- classifier arrays/summaries not derived from the retained PNG bytes;
- weak provenance, filename, draw-count, XYS, camera-identity, and canonical
  latest/first-red bindings.

Work already present in the paused bytes includes strict incoming schema work,
canonical-current latest/first-red handling, foreign-prior restoration, the
exact 55-degree camera/derived height and footprint, independent WGS84
row-major projection, filename/provenance/draw linkage, physical noneclipse
constraints, derived camera identity, retained control ephemeris,
cross-backend XYS/ephemeris checks, and a decoded immutable-PNG classifier
proof. A migrated green synthetic report passed once before the remaining
adversarial/lifecycle tests were being added.

Resume rule: rehash these exact bytes first, continue the unfinished mutant and
lifecycle suite, run the full focused gate plus syntax/ESLint/Prettier/diff
checks, freeze a new tuple, and obtain a fresh non-author read-only review. Do
not infer GO from the one green synthetic test.

## 5. Paused packet B — C12-11 star-catalog certification

Owner to resume: `/root/harden_c12_11_star_catalog`

Status: the original feature-frozen tuple is still byte-exact. Independent
review is **NO-GO**. The repair task had been accepted, but no repair write had
landed before this pause.

Current/frozen tuple:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Tools/visual-regression/probe-stars-catalog.mjs` | 47,925 | `827CE9E1AA65F4C30A5ACC2C466FCC2D579657C21077641D738C3C45F7855D2A` |
| `Tools/visual-regression/lib/c12-11-star-catalog-gate.mjs` | 35,048 | `744E5B920612C61F7AE2592956DAB790E9AAAD1AD669F350B7BFD3139430E3D2` |
| `Tools/visual-regression/c12-11-star-catalog-gate.spec.mjs` | 27,250 | `DBB703D5C676876BE31E07A8F66EC393015D41EC6013C4B2DC3472EC6A869BB5` |

Self-tests before review:

- focused C12-11: 66/66 PASS;
- star-point census + skybox seam neighbors: 36/36 PASS;
- syntax, ESLint, Prettier, and scoped diff checks PASS.

These green tests did not cover the independent blockers:

1. A foreign latest swapped between the prior read and rename can be stranded
   in the receipt while canonical latest becomes absent.
2. The same foreign-owner loss exists during lock release.
3. There is no write-once UUID-bound first-red authority.
4. A stale G3 PASS from another commit/build can unblock C12-11; required
   source/dirty/browser/served provenance is discarded.
5. The G3 dependency boundary omits load-bearing helper modules/assets.
6. The probe lacks `offline=true` and does not reject successful external
   transport.
7. The star-feature source boundary omits direct/transitive dependencies such
   as `SkyBoxResolutionPolicy.js`, `computeAtmosphereExtinction.js`, and WebGPU
   star-renderer helpers.
8. During a new run, canonical latest remains the prior final instead of the
   owned current RUNNING authority.
9. The PNG parser accepts unknown critical chunks and trailing compressed
   garbage.
10. A byte-identical immutable archive cannot be retried after a later
    publication failure.

Protected historical PNGs remain byte-exact and must never be overwritten:

| Image | Bytes | SHA-256 |
| --- | ---: | --- |
| `blank` | 186,081 | `D4B5D7152BF34AFB5C061EFBCF9A1AA0975DFCD4633AF5DF15A26167BDE12A0E` |
| `bright` | 143,393 | `4266BC11554369B05E56CA8D82347492B233B508BDFB77627FC3DAFED250A206` |
| `off` | 138,390 | `BD9C8CEB5EDEF45DBD7E004585C8A2FAD2197D34F3457034E7EC847554132FDC` |
| `sirius` | 141,540 | `4F7E9B60FA1891176C50D44A398DCEB9FA4EA97D83F6B329FA8A0D80C9181FFB` |

Resume rule: implement all ten findings in only the three listed paths, add
adversarial mutants, rerun focused and neighbor gates, freeze, and return the
same independent C12-31 reviewer for re-review. No live run can certify until
G3 has a current eligible PASS.

## 6. Paused packet C — C12-31 L1-L4 aureole core

Owner to resume: `/root/harden_c12_31_core`

Status: independent review is **NO-GO**. The repair started, but only the gate
library had changed when paused. This is a mixed mid-repair tuple and must not
be tested or reviewed as the earlier freeze.

Current bytes at pause:

| File | Bytes | SHA-256 | Note |
| --- | ---: | --- | --- |
| `Tools/visual-regression/probe-sky-aureole-anchor.mjs` | 43,170 | `047BED227EB80C20083424157F41F3A677345B73373E1DC0429B016583926B29` | still original freeze |
| `Tools/visual-regression/lib/c12-31-aureole-gate.mjs` | 39,253 | `EB56F27977E5E7FC69740B556A14E3BD493277070CD433928329E91D4083D829` | partial repair |
| `Tools/visual-regression/c12-31-aureole-gate.spec.mjs` | 30,473 | `A093843773F710171E9D9123A952654BD9CE4A944697AAD0D63CDE7D65994EF9` | still original freeze |

Original self-tests were 22/22 focused plus 24/24 sky-light neighbors, with
syntax/ESLint/Prettier/diff checks green. Independent review found:

1. Actual browser-consumed runtime bytes and successful external transport are
   unbound; a separate post-navigation fetch is not authoritative.
2. WebGPU device/error hooks arm after navigation even though the artifact
   claims pre-navigation coverage.
3. Continuous rendering can overwrite the current-frame draw witness after
   `toDataURL` while PNG decoding awaits, binding the witness to a later frame.
4. Prior latest is not required to be byte-identical to its UUID archive.
5. Source-map hash/length are recorded but not folded.
6. Page/context/browser acquisition and teardown are unbounded and lack
   observed closure proof.
7. Failures after lock acquisition can strand the owned lock.
8. The source-currentness boundary omits load-bearing files including
   `Scene.js`, `EnvironmentRenderer.js`, `WebGPUAtmosphereUniforms.ts`,
   `SkyAtmosphereVS.js`, `SkyAtmosphereCommon.js`, and `AtmosphereCommon.js`.

Resume rule: finish the probe/lib/spec repair and exact mutants for all eight
items, run the full focused and neighbor suites plus static/style gates, freeze
a new three-file tuple, and send it back to the same C12-11 reviewer. The
packet remains honestly scoped to L1-L4 core only; it must not claim full
C12-31 closure.

## 7. Browser/evidence state to preserve

- No Cesium server is running. Ports 8080/8081 were deliberately closed after
  the last certified build audit.
- Do not restart a server until the final source tuple is landed and a new
  detached clean build is complete.
- CUSTOM v6 preserved evidence includes an initial ERROR and a later
  STRUCTURAL run. Forensics classified the latter's reds as probe/gate
  instrumentation defects, not an engine defect. CUSTOM v7 landed the bounded
  repairs, but **no authoritative v7 browser rerun has occurred yet**.
- G3 static certification is green, but the required exact active 4096 diffuse
  star-cube tier is absent; current hardware honestly resolves to 2048 and must
  remain STRUCTURAL. Do not run or claim G3 PASS until the six 4096 diffuse
  faces plus policy/license/manifest provenance are installed and reviewed.
- C12-11 is gated behind that future eligible G3 PASS.
- C12-33's offline contract/finalizer is landed, but browser calibration is
  still owed: ten distinct runs forming five AB/BA pairs, retained 104-PNG raw
  packets, calibrated thresholds, and an independent reviewer finalization.
- The external evidence library previously verified clean at
  `F:\Dev\GH\cesium-webgpu-visual-evidence` (30 publications, 114/114 referenced
  objects, no orphaned objects at that audit).
- The sole eligible terrain prerequisite for the later dense run is:
  `F:\Dev\GH\cesium-webgpu-visual-evidence\runs\c12-29-s5-terrain-selection\83aea7d0-7c8e-4543-8818-7cc459cb01c3\manifest.json`
  (manifest SHA-256
  `A2A49CD83892122ECF6F268CDFED2EB62DBDF5A05FC1EBFA82F2C44ED9624227`).
- Dense cost certification remains serialized after a new NASA publication;
  never run GPU probes concurrently or share mutable output namespaces.

## 8. Exact resume order

When the maintainer says **go**:

1. Re-list agents and reactivate the three interrupted canonical tasks; do not
   spawn competing writers on their paths.
2. Rehash the nine paused files against sections 4-6 before any edit.
3. Finish and independently re-review NASA/SVS v5.
4. Finish and independently re-review C12-11.
5. Finish and independently re-review C12-31 L1-L4.
6. Land each independently reviewed packet in a separate path-scoped commit.
   Hooks may temporarily stash unrelated work, so every active owner must
   rehash after each commit.
7. Advance the detached certification worktree to the new HEAD; clean generated
   outputs; run one final `npm run build -- --sourcemap --no-node`; verify source
   maps and tracked cleanliness.
8. Run all authoritative static gates serially on that exact build.
9. Start one production disk-serving server from the cert tree, verify both
   ports/routes and served/local bundle hashes, then run browser certification
   one probe at a time in fresh output namespaces.
10. Archive only immutable eligible artifacts after process exit and independent
    validation; never archive canonical latest, RUNNING receipts, locks,
    recovery files, or first-red as if they were a PASS artifact.
11. After the current packets: harden the C12-31 limb detector and model-IBL
    threshold probes as two disjoint tools-only waves. Preserve all historical
    fixed-name PNGs; use UUID-bound write-once artifacts, exact persisted-PNG
    scoring, current-frame readiness, transport/GPU/provenance gates, and
    independent review before browser use.
12. Continue the recorded machine queue: G3 4096 asset session, C12-33 paired
    calibration, C12-11 Edge certification, full C12-31 acceptance tail,
    C12-G1F2 attribution, C12-12 default-sky identity, remaining C12 exit
    matrices, then Aurora/space-weather planning and finally the engine/Scene/
    renderer correctness and performance audit.

## 9. Pause invariant

The campaign objective is **not complete and not blocked**. It is intentionally
paused at the maintainer's request with recoverable exact bytes and a concrete
resume order. Make no additional progress until the maintainer explicitly says
**go**.
