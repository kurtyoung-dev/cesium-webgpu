// authorities.mjs - the governance files a worker clone must carry and the authorities AGENTS.md routes to.
// @purpose Declare, as data, which governance files Tools/provision-worker-clone.mjs copies from the source repo into a clone (and why) and which routed authorities the readiness check requires to exist there.
// @status ACTIVE

/**
 * Governance a clone cannot obtain from git, and why.
 *
 * `required: true` means a worker MUST NOT be dispatched without it. Anything
 * AGENTS.md routes to as a binding authority belongs here — the router promising
 * a document the clone lacks is precisely the failure the provisioner closes.
 */
export const PROVISION = [
  {
    src: "CLAUDE.md",
    dest: "CLAUDE.md",
    required: true,
    why: "tracked since Batch 1434 (33416b6036), but the seat edits it constantly — a clone made before an edit lands is briefed from stale rules",
  },
  {
    src: "AGENTS.md",
    dest: "AGENTS.md",
    required: true,
    why: "the router itself; tracked since Batch 1058 (54ead62ee5), but a clone made before a router change lands routes to the old authorities",
  },
  {
    src: "migration_doc/MAINTAINER_RULINGS_2026-08-17.md",
    dest: "migration_doc/MAINTAINER_RULINGS_2026-08-17.md",
    required: true,
    why: "current ruling series — supersedes every document below it",
  },
  {
    src: "migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md",
    dest: "migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md",
    required: true,
    why: "the worker's own procedure: lease, rebase rules, handoff report",
  },
];

/** Authorities AGENTS.md routes to. A router that promises these must deliver. */
export const ROUTED_AUTHORITIES = [
  "CLAUDE.md",
  "AGENTS.md",
  "migration_doc/EXECUTOR_LANE_CHARTER_2026-08-14.md",
  "migration_doc/MAINTAINER_RULINGS_2026-08-14.md",
  "migration_doc/MAINTAINER_RULINGS_2026-08-17.md",
  "migration_doc/WORKER_ISOLATION_AND_BRANCH_HANDOFF.md",
  "migration_doc/ORCHESTRATION_HANDBOOK.md",
  "migration_doc/CODEX_SOL_OPERATING_BRIEF.md",
];
