# Maedhros — Q-152 typed child-result contract lease

- Status: ACTIVE / UNFROZEN
- Tier-2 owner: Maedhros
- Active writer: Maglor
- Live agent path: `/root/maedhros_child_hardening_scope/maglor_variant_contract`
- Base: `a64954b94507fa29762964f3d410517ddd765e9e`
- Branch: `sol/q152-child-result-contract-ba64954b945-2026-08-29`
- Clone: `F:/Dev/GH/cesium-lane-maedhros-child-contract-20260829`
- Reap when: the contract and spec are frozen, independently reviewed, either assembled with their consumers or declined, and all handoffs are repatriated; target 2026-09-05.
- Disk budget: 2 GiB.

## Declared path set

- `Tools/visual-regression/lib/wave-child-result-contract.mjs`
- `Tools/visual-regression/wave-child-result-contract.spec.mjs`

Both paths were absent and collision-free at dispatch. The worker branch must remain at the base; the orchestrator owns every Git operation and any eventual assembly or commit.

At the last root checkpoint both deliverable paths were still absent, so there is no authored tuple, freeze, validation, or review to preserve yet. Maglor is authorized to create only those paths through the bounded patch engine. Do not reset, retire, delete, review, or reuse the clone while that write remains active.

## Dispatch constraints

- One deliverable: a pure, versioned, canonical typed child-result contract plus behavioral specification.
- Reuse the frozen verdict table and existing stable serialization, hashing, atomic-write, and fingerprint helpers where their contracts fit; do not create competing primitives.
- No child integration, `package.json` change, Git write, dependency installation, build, browser, server, network, evidence publication, or external-state change in this lease.
- The candidate remains unlanded until its consumers and runner-home assembly are ready; freeze exact bytes before independent review.
- Consumer integration and a tracked runner home are separate held assemblies; this lease alone cannot certify or land an orphan helper.
