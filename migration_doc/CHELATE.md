# chelate — the Rust process supervisor (relocated)

**Status (2026-09-02):** relocated out of this repository by maintainer ruling `R-2026-09-02-13`
(`MAINTAINER_RULINGS_2026-09-02.md`). It lives at `F:/Dev/GH/chelate` as its own local git
repository; it has no remote. Certification for production use and any Q-152 integration remain
**NO-GO** until the certification row is funded (the ruling defers the trust root and the Q-152
runner names to that point).

## What it is

A Windows-first process supervisor (job objects, handle discipline, framed protocol, crash
evidence) written for the Edge executor's child-process isolation, with a Unix backend and a
general CLI that the ruling keeps. The name is one prefix across crates and binaries:
`chelate-core`, `chelate-native`, `chelate-protocol`, `chelate-cli` (binary `chelate`),
`chelate-test-child`, `chelate-tests`; the `q152-process-runner` crate keeps its name pending
certification.

## Provenance

- Baseline commit `fc5e888` in the relocated repository is a byte-identical copy of the never-tracked
  in-tree prototype (`Tools/process-supervisor`, `target/` excluded, vendored crates included), taken
  before any audit or rename. The in-tree copy was deleted after that baseline was verified.
- The audit, rename and improvements landed as the next commit there (lane Amandil, reviewed by
  Galathil; packet `_lane-out/LANDING_PACKET_AMANDIL.md` in that repository).
- Supply-chain record: `SUPPLY_CHAIN.md` in that repository is append-only and carries the
  relocation, the reproduced vendor closure and the rename map with hashes.
- Earlier reviews in this repository: `migration_doc/branches/reviews/denethor--rust-process-supervisor-supply-chain-review.md`
  and the Tier-2 audit banked at `F:/Dev/GH/cesium-webgpu-worker-archive/audit-2026-09-01/`.

## Build and test

Pinned toolchain `1.94.0` (`rust-toolchain.toml`); vendored sources via `.cargo/config.toml`, so
`cargo build --offline` and `cargo test --offline --no-fail-fast` work without network. `TEST_PLAN.md`
there names the retained reds and their expected counts.

## Rules that still apply here

Nothing in this repository invokes chelate. Any future integration is an engine/tooling change
under the full proof bar and needs the certification row closed first.
