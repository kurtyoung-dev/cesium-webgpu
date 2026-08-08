# Automation Attestation

This repository is developed by an **autonomous AI agent pipeline** (a
Claude-based orchestrator directing worker agents), which runs continuously
and lands work in batches around the clock.

**Commit timestamps in this repository reflect automated landings by that
pipeline — not personal working sessions of the repository owner.** The
pipeline executes builds, tests, verification probes, and commits without a
human at the keyboard; the owner's personal involvement is limited to
direction, review, and rulings, conducted outside normal business hours.

Supporting evidence is native to the repository itself:

- Nearly every commit message names the orchestrator/worker batch pattern
  under which it was produced.
- The landing cadence (frequently a dozen or more batches in a single day,
  minutes apart, at all hours) reflects machine execution, not manual
  development.
- The engineering ledgers under `migration_doc/` document the agent
  dispatch, review, and landing protocol in detail.

**Policies (effective August 2026):**

1. Automated commits are authored under the dedicated agent identity
   `cesium-webgpu-agent`, distinct from the repository owner's personal
   GitHub identity.
2. The pipeline does not commit or push on weekdays between 07:00 and
   19:00 US Eastern time.

This attestation exists so that repository activity is not mistaken for
personal working-hours activity by the owner.
