# GP E6 source-fixture landing record

Planned Batch1450 on main, parent
`db69161b02a0eb0e3f377d8ff8229718525e43fe`. Root owns Git; no push is authorized.
Commit execution is pending. This is a source-fixture correction under C13-43,
not closure of the cloud campaign or acceptance of rendered behavior.

## Exact scope

Only `Tools/visual-regression/celestial-water-globe-port.spec.mjs`, this record,
and the isolated C13-43 GP queue stamp are selected. Tested source is75605 bytes /
`5dcea2f14775c8e616394f88045e3ab2629bc3a734228a76132298521b84ebc3`.
The105-addition/15-removal source diff replaces stale E6 bit36/37 literals with
semantic checks for the existing named bit41/42 values and adds E6a's four
negative controls plus a comment-rewording positive. No shader bit is changed.

Root verified the production key/gate files match HEAD. The only unrelated
dirty GP prerequisites are package registrations and Globe's managed-cloud
default/comments. GP's Globe checks read unchanged ocean defaults, imports and
property forwarding; neither unrelated change is required by this fixture fix.
Those changes, all other tooling/cloud code and their status edits are excluded.

## Validation and independent review

One accepted source-adapter invocation produced56/56 PASS, ordinary native/public0,
complete10571-byte stdout, empty stderr, no truncation/timeout/force,22 stable
adapter labels and the full23-record prospective closure unchanged. Removing E6a
reproduces the historical55-name sequence; only E6 changes FAIL to PASS. The old
54/55 FAIL remains immutable. A false PowerShell-count assessment is also retained;
its correction derives from the same unchanged raw facts, not a rerun.

Artifacts below are relative to `tmp/astra-dev-unblock-20260906/_lane-out/`:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `faramir-gp/GP_E6_CORRECTED_SOURCE_CHECK_01/command.jsonl` | 41904 | `18476b696ef97813be952a5b2f5e74d9b353cae2eba27e6f9233b8a5f14d4a46` |
| `faramir-gp/GP_E6_CORRECTED_SOURCE_CHECK_01/source-check.json` | 13147 | `3b455aeea21674e743d8c068441069579243e512ec78c95d72fbb8839acc51ac` |
| `elrond/C13_43_GP_E6_SOURCE_REVIEW_02.md` | 4266 | `2b0ad0ffc89dbc6d1e6c4901c62347caea192a8bbecbe799e4ff1cc04c36283c` |
| `elrond/C13_43_GP_E6_EVIDENCE_REVIEW_03.md` | 5315 | `03e93a21d932bc78d8a2fcf6bd4f3e8ffcad8682206ed5edde0214b48b7ec82d` |

Root read both complete GO reviews, the source delta, retained capture handoff,
dependency boundary and actual normal commit hooks. Final source/input rehash,
exact index review, normal hooks and worktree-preservation checks are required.
Git's normal text filtering may make a committed LF blob differ from the tested
Windows working-byte hash; both identities must remain explicit.

No browser, GPU, shader compilation, build freshness, fleet, process-tree or
cloud-default claim follows. The reader/parser and other campaign work stay open.
