# Maedhros — Q-152 typed child-result contract lease

- Status: **FROZEN / INDEPENDENT GO / LANDING HELD**
- Tier-2 owner: Maedhros
- Author: Maglor, quiescent
- Test authority: Caranthir, quiescent
- Independent reviewer: Curufin, quiescent
- Base and clone HEAD: `a64954b94507fa29762964f3d410517ddd765e9e`
- Base and clone HEAD tree: `3247f590e9613b34320e6a9abbb676a132d00cd4`
- Branch: `sol/q152-child-result-contract-ba64954b945-2026-08-29`
- Clone: `F:/Dev/GH/cesium-lane-maedhros-child-contract-20260829`
- Push authority: **none**
- Reap when: the frozen contract is assembled atomically with its first real child consumer and package runner, that assembly is independently reviewed, all handoffs are repatriated, and the orchestrator makes the clone-retention decision; target 2026-09-05.
- Disk budget: 2 GiB.

## Declared path set and frozen tuple

This lease authored only the following two paths. Both were absent and collision-free at dispatch.

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `Tools/visual-regression/lib/wave-child-result-contract.mjs` | 25,463 | `142367925069EFB2C689971D0F792A5ABF93B7F81C75EF96B975912714FB7458` |
| `Tools/visual-regression/wave-child-result-contract.spec.mjs` | 23,152 | `EC6A26B813DDA1EE2CDA900A1ECF4BC32D4B62635E54BDF04926A7DA990572AB` |

The terminal review observed clone porcelain containing exactly these two untracked paths and no other entry. Any byte change invalidates this tuple and its review.

No additional source, consumer, parent runner, package script, queue, ledger, browser artifact, or evidence namespace belongs to this lease.

## Delivered H0 boundary

The frozen library is a pure, versioned child-result contract. It supplies closed RUNNING and FINAL records, canonical `PASS` / `FAIL` / `ERROR` / `STRUCTURAL` exit semantics through the existing verdict helper, strict root-supplied provenance and artifact references, lifecycle and timeout binding, hostile-input-safe rebuilding, deterministic canonical JSON and SHA-256 identity, and exact-child-set aggregation that retains primitive reds.

It deliberately performs no filesystem, Git, browser, process-control, environment, clock, randomness, server, runner, or evidence-publication work. Those are integration obligations, not capabilities implied by the H0 review.

## Validation and independent review

Caranthir previously reported the following focused evidence against the exact frozen tuple:

- `node --check Tools/visual-regression/lib/wave-child-result-contract.mjs` — exit `0`.
- `node --check Tools/visual-regression/wave-child-result-contract.spec.mjs` — exit `0`.
- `node --test Tools/visual-regression/wave-child-result-contract.spec.mjs` — `18/18` passed, with no failures or skips.

This syntax `0/0` and focused `18/18` evidence is **external/reported evidence**. Curufin did not rerun Node or the specification during the terminal review.

Curufin terminally reread and rehashed the exact tuple and returned **GO for the pure H0 exact tuple only**, with all six prior findings carried forward as FIXED and no required finding open. The banked review is:

- `migration_doc/branches/reviews/curufin--q152-child-result-contract-review.md`
- 10,812 bytes
- SHA-256 `A02AFBD1758978C83801131585B6B2DA38C892FFE6A3AECF4B575ABD051F3EBD`

The review makes no child-integration, parent-composition, runner-reachability, build, browser, server, evidence, or certification claim.

## Landing hold

**Do not land H0 as an orphan helper.** Its pure-library GO does not authorize a commit or make it a useful runtime boundary by itself.

The smallest eligible assembly is the unchanged frozen H0 tuple plus:

1. its first real child-native consumer;
2. that consumer's focused pure-Node integration coverage; and
3. an existing named `package.json` runner home that actually executes both the H0 and consumer specifications.

Those paths require a new explicit, collision-audited lease. Freeze and independently review the complete assembly before any landing decision. If either H0 file changes during assembly, repeat its focused validation and exact-tuple review rather than carrying this GO forward.

The orchestrator owns every Git operation and any eventual assembly or commit. Push authority is none.

## Open integration obligations

The following remain open and must not be represented as discharged by H0:

- **Root provenance:** define and root-supply invocation identity, source commit, dirty state, source-identity algorithm and subject, and exact input fingerprints. H0 validates supplied values but does not establish their origin.
- **Runtime paths and lifecycle:** allocate invocation-unique, root-contained child-result and parent-receipt paths; publish RUNNING and FINAL atomically; prevent stale replay, overwrite, path escape, and predecessor loss; retain timeout, signal, cleanup, and quiescence facts.
- **Child adapters:** make variant smoke, the Sandcastle2 sweep, and capture-and-diff emit child-native H0 records without collapsing their existing primitive results into binary exits or duplicating their detailed reports.
- **Parent composition:** replace competing parent-local result schemas with H0 validation and identity, require the exact plan-derived child census, bind raw exits and provenance, preserve every primitive red, and fold through the canonical contract.
- **Package runner:** place every new pure-Node specification in an existing named npm runner before landing; no runnerless spec satisfies `R-2026-08-29-1`.
- **Edge and certification:** build/served identity, actual child execution, both Sandcastle renderers, all three variants, capture-and-diff, descendant quiescence, browser artifacts, evidence banking, and Q-152 certification remain separate gated work. No browser or certification evidence exists in this lease.

## Resume protocol

1. Confirm the campaign ruling and queue state, then collision-audit the intended first-consumer, focused-spec, parent, and `package.json` paths.
2. Rehash both H0 files and the Curufin report. Stop on any drift.
3. Grant one writer a new bounded first-consumer/runner assembly lease. Keep the H0 paths frozen unless a concrete integration finding requires reopening them.
4. When separately authorized, run only the preregistered pure-Node syntax and focused integration checks; record exact exits and hashes after the last mutation.
5. Freeze the complete assembly and obtain a fresh independent review. A reviewer of only H0 cannot approve its consumer or runner wiring.
6. Land only with explicit orchestrator authority. Do not push.
7. Open build, server, Edge/browser, real-child, evidence, and certification work only through their own later authorizations and gates.

## Quiescence and no-action boundary

Maglor, Caranthir, and Curufin have delivered their bounded results and are quiescent. No lane-owned browser, server, port, build, child process, evidence publication, or incomplete runtime result is active. The frozen source tuple and banked review remain held in their declared locations.

This handoff reconciliation changes documentation only. It does not run Git writes, tests, builds, browsers, servers, network activity, real children, or evidence publication, and it grants no deletion, landing, commit, or push authority.
