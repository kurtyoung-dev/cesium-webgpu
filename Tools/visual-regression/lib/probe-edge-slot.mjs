// probe-edge-slot.mjs — the single-Edge-slot lock every browser job takes.
//
// @purpose Exclusive-create lock file that enforces "one Edge job at a time", with stale/dead-holder reclamation and a release that will not free a slot someone else already took.
// @status ACTIVE
//
// WHY A LOCK AND NOT A CONVENTION. "One Edge job at a time" is a maintainer
// rule (R-2026-09-02-1) because two concurrent browsers contend for the same
// GPU: every frame time, every settle-frame count and every pipeline-compile
// duration either job records is then a measurement of the other job as much as
// of the subject. A convention is obeyed by whoever remembers it; a lock is
// obeyed by everyone, including a probe launched from a second terminal by
// someone who did not know a tranche was running.
//
// FAIL-CLOSED, WITH THREE WAYS OUT. The lock is taken with an exclusive create
// (`wx`), so the race between two acquisitions is resolved by the filesystem
// rather than by a read-then-write window. An existing lock is only reclaimed
// when it is demonstrably not a live holder: its contents are unreadable, its
// recorded pid is gone, or it is older than the staleness bound. A crashed run
// therefore does not wedge the next day's work, and a live run is never
// double-booked.
//
// RELEASE IS OWNERSHIP-CHECKED. Each acquisition writes a random token. Release
// removes the file only when the token on disk is still ours — otherwise a run
// whose slot was reclaimed as stale would delete the lock belonging to the job
// that took over, and that job would then run unprotected.

import fs from "node:fs";
import path from "node:path";

import { ProbeRefusal } from "./probe-refusal.mjs";

/** Where the lock lives, relative to the repository root. */
export const DEFAULT_EDGE_SLOT_LOCK_PATH =
  "Tools/visual-regression/output/.edge-slot.lock";

/**
 * A lock older than this is treated as abandoned even if some process still
 * holds its pid. Two hours is longer than any tranche leg on record and short
 * enough that a crashed run does not wedge the next day's work.
 */
export const EDGE_SLOT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * @param {number} pid A process id.
 * @returns {boolean} Whether a process with that id is still running.
 */
function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — alive.
    return error?.code === "EPERM";
  }
}

/**
 * Decide what to do about an existing lock file, given its parsed contents.
 * Pure, so the busy/stale/corrupt/dead cases are all reachable from a spec
 * without arranging a second live Edge run.
 *
 * @param {object} options Inputs.
 * @param {object|null} options.holder Parsed lock contents, or `null` when unreadable.
 * @param {number} options.now Current epoch milliseconds.
 * @param {number} options.staleAfterMs Age past which a lock is abandoned.
 * @param {(pid: number) => boolean} options.isProcessAlive Liveness probe.
 * @returns {{reclaim: boolean, reason: string}} What to do and why.
 */
export function decideEdgeSlot({ holder, now, staleAfterMs, isProcessAlive }) {
  if (!holder || typeof holder.pid !== "number") {
    return { reclaim: true, reason: "unreadable-lock" };
  }
  const acquiredAt = Number(holder.acquiredAt);
  if (!Number.isFinite(acquiredAt) || now - acquiredAt >= staleAfterMs) {
    return { reclaim: true, reason: "stale-lock" };
  }
  if (!isProcessAlive(holder.pid)) {
    return { reclaim: true, reason: "dead-holder" };
  }
  return { reclaim: false, reason: "held" };
}

/**
 * Take the single Edge slot, or refuse.
 *
 * @param {object} options Inputs.
 * @param {string} options.lockPath Absolute path to the lock file.
 * @param {string} options.owner A label recorded in the lock (usually the probe name).
 * @param {number} [options.now] Current epoch milliseconds.
 * @param {number} [options.pid] The acquiring pid.
 * @param {number} [options.staleAfterMs] Age past which a lock is abandoned.
 * @param {(pid: number) => boolean} [options.isProcessAlive] Liveness probe.
 * @returns {{lockPath: string, owner: string, pid: number, acquiredAt: number, reclaimed: string|null, release: () => void}} The held slot.
 */
export function acquireEdgeSlot({
  lockPath,
  owner,
  now = Date.now(),
  pid = process.pid,
  staleAfterMs = EDGE_SLOT_STALE_AFTER_MS,
  isProcessAlive = defaultIsProcessAlive,
}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${pid}:${now}:${Math.random().toString(36).slice(2, 10)}`;
  const record = { owner, pid, acquiredAt: now, token };
  const body = `${JSON.stringify(record, null, 2)}\n`;

  let reclaimed = null;
  try {
    fs.writeFileSync(lockPath, body, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    let holder;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      // A lock we cannot read is a lock we cannot trust; `decideEdgeSlot`
      // treats that as abandoned rather than as a live holder.
      holder = null;
    }
    const decision = decideEdgeSlot({
      holder,
      now,
      staleAfterMs,
      isProcessAlive,
    });
    if (!decision.reclaim) {
      throw new ProbeRefusal(
        "edge-slot-busy",
        `another Edge job holds the single Edge slot (${lockPath}); run one browser job at a time`,
        { lockPath, holder },
      );
    }
    fs.writeFileSync(lockPath, body);
    reclaimed = decision.reason;
  }

  return {
    lockPath,
    owner,
    pid,
    acquiredAt: now,
    reclaimed,
    release() {
      // Only remove a lock that is still ours. A slot reclaimed out from under
      // this run (a stale-lock takeover by a later job) must not be deleted
      // here, or the later job would proceed unprotected.
      try {
        const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (current?.token !== token) {
          return;
        }
      } catch {
        return;
      }
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // A slot that cannot be removed is reported by the next acquisition's
        // staleness check; failing teardown here would mask the run's result.
      }
    },
  };
}
