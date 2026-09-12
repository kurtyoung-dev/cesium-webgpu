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
    token,
    /**
     * Whether the lock on disk still carries THIS acquisition's token. A slot
     * reclaimed as stale by a later job leaves the file present and readable,
     * so presence alone cannot answer the question a run must answer before it
     * measures: am I still the job that holds the GPU?
     *
     * @returns {boolean} Whether the lock is still ours.
     */
    heldByUs() {
      try {
        return JSON.parse(fs.readFileSync(lockPath, "utf8"))?.token === token;
      } catch {
        return false;
      }
    },
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

/**
 * How long a release may take before the lifecycle treats the slot as stuck.
 * The lock is a file, so a release is an `unlink`; the budget exists because
 * `withProbeLifecycle` sizes its hard-stop grace from it and a grace derived
 * from nothing is a grace nobody can reason about.
 */
export const EDGE_SLOT_CLOSE_TIMEOUT_MS = 5000;

/**
 * Hold the single Edge slot for the duration of `callback`, exposing the lease
 * observations `withProbeLifecycle` needs.
 *
 * WHY THIS WRAPPER EXISTS RATHER THAN A SECOND SLOT MECHANISM. The lifecycle
 * this fork adopted (C13-42a) was written against a slot that coordinates
 * through a loopback listener, whose lease naturally publishes "the listener
 * closed" and "the release settled". This fork's slot is the exclusive-create
 * lock file every other Edge job on the machine already takes, including the
 * wave-end gate, so replacing the mechanism would silently stop those jobs
 * excluding each other. The lock file therefore stays, and this wrapper
 * supplies the same three observations over it — with one honest difference in
 * WHEN they fire, stated here rather than glossed:
 *
 * - `assertHeld()` re-reads the lock and compares the acquisition token, so a
 *   run whose slot was reclaimed as stale finds out instead of measuring on a
 *   GPU it shares.
 * - `loss` is a NON-rejecting promise that settles when ownership is observed
 *   lost, so a caller may race it against work and still drain that work.
 *   **A file lock cannot PUSH.** A listener emits `close`/`error` the moment it
 *   stops holding the port; a lock file just sits there with someone else's
 *   token in it. So `loss` here settles at the points where ownership is
 *   actually LOOKED AT — each `assertHeld()`, and the release — not at the
 *   instant of the theft. A run that is stolen mid-`cells` learns about it at
 *   its next bracket, which is before it can report, and that is the property
 *   that matters; a caller that never checks would learn at the release.
 *   Polling was considered and rejected: it would add a timer to every probe
 *   to shorten a detection window nothing reads inside.
 * - `whenClosed` / `releaseOutcome` settle when the release is attempted, which
 *   is what lets the lifecycle prove the slot was actually given back rather
 *   than assuming it.
 *
 * @template T
 * @param {object} options Inputs.
 * @param {string} options.owner Label recorded in the lock.
 * @param {string} options.lockPath Absolute path to the lock file.
 * @param {number} [options.now] Acquisition time, for receipts.
 * @param {number} [options.pid] The acquiring pid.
 * @param {number} [options.staleAfterMs] Age past which a lock is abandoned.
 * @param {(pid: number) => boolean} [options.isProcessAlive] Liveness probe.
 * @param {(observation: object) => void} [options.onLeaseObservation] Receives `{ whenClosed, releaseOutcome }` synchronously once the slot is held.
 * @param {(slot: Readonly<object>) => Promise<T>|T} callback Work that owns the slot.
 * @returns {Promise<T>} The callback result, after the slot is released.
 */
export async function withEdgeSlot(
  {
    owner,
    lockPath,
    now = Date.now(),
    pid,
    staleAfterMs,
    isProcessAlive,
    onLeaseObservation,
  },
  callback,
) {
  if (typeof callback !== "function") {
    throw new TypeError("withEdgeSlot callback must be a function");
  }
  if (typeof lockPath !== "string" || lockPath.length === 0) {
    throw new TypeError(
      "withEdgeSlot requires the Edge-slot lockPath; a path-addressed slot cannot infer one",
    );
  }
  // A refusal here (`edge-slot-busy`) propagates unchanged: it is a governance
  // decision taken before any browser exists, and wrapping it would turn an
  // exit-3 refusal into an exit-2 error.
  const held = acquireEdgeSlot({
    lockPath,
    owner,
    now,
    ...(pid === undefined ? {} : { pid }),
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
    ...(isProcessAlive === undefined ? {} : { isProcessAlive }),
  });

  let loss;
  let resolveLoss;
  const lossSignal = new Promise((resolve) => {
    resolveLoss = resolve;
  });
  const reportLoss = (error) => {
    if (loss !== undefined) {
      return;
    }
    loss = error;
    resolveLoss(error);
  };

  let closing = false;
  let resolveWhenClosed;
  const whenClosed = new Promise((resolve) => {
    resolveWhenClosed = resolve;
  });
  let settleReleaseOutcome;
  const releaseOutcome = new Promise((resolve) => {
    settleReleaseOutcome = (record) => resolve(Object.freeze(record));
  });
  const observation = Object.freeze({ whenClosed, releaseOutcome });

  const assertHeld = () => {
    if (loss !== undefined) {
      throw loss;
    }
    if (closing || !held.heldByUs()) {
      const error = new Error(
        `the Edge slot (${lockPath}) is no longer held by ${owner}`,
      );
      reportLoss(error);
      throw error;
    }
  };

  const slot = Object.freeze({
    lockPath: held.lockPath,
    owner: held.owner,
    acquiredAt: held.acquiredAt,
    reclaimed: held.reclaimed,
    assertHeld,
    loss: lossSignal,
    whenClosed,
    releaseOutcome,
  });

  let hookFailed = false;
  let hookError;
  if (onLeaseObservation !== undefined) {
    try {
      // Synchronous, so the lifecycle captures the observation before the
      // callback can assert ownership or start work against it.
      onLeaseObservation(observation);
    } catch (error) {
      hookFailed = true;
      hookError = error;
    }
  }

  let value;
  let callbackFailed = false;
  let callbackError;
  if (hookFailed) {
    callbackFailed = true;
    callbackError = hookError;
  } else {
    try {
      assertHeld();
      value = await callback(slot);
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
    }
  }

  closing = true;
  const releaseRecord = {
    attempted: true,
    occurred: false,
    succeeded: false,
    rawCause: undefined,
  };
  let releaseFailed = false;
  let releaseError;
  try {
    const stillOurs = held.heldByUs();
    held.release();
    releaseRecord.occurred = true;
    // A slot already taken from us was never ours to give back; the release is
    // a no-op by design, and reporting it as success would hide the takeover.
    releaseRecord.succeeded = stillOurs;
    if (!stillOurs) {
      releaseRecord.rawCause = new Error(
        `the Edge slot (${lockPath}) had already been reclaimed from ${owner}`,
      );
      reportLoss(releaseRecord.rawCause);
    }
  } catch (error) {
    releaseRecord.occurred = true;
    releaseRecord.rawCause = error;
    releaseFailed = true;
    releaseError = error;
    reportLoss(error);
  }
  settleReleaseOutcome(releaseRecord);
  resolveWhenClosed();

  const failures = [];
  if (callbackFailed) {
    failures.push(callbackError);
  }
  // A slot lost mid-run fails the job even when the callback returned: the
  // measurement it returned was taken on a GPU another job had already been
  // handed. De-duplicated by identity, because `assertHeld` reports the loss
  // and then throws the same error.
  if (loss !== undefined && !failures.includes(loss)) {
    failures.push(loss);
  }
  if (releaseFailed && !failures.includes(releaseError)) {
    failures.push(releaseError);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "the Edge-slot lifecycle failed");
  }
  return value;
}
