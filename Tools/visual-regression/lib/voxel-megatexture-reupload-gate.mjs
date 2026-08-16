// Browser-free contract for probe-voxel-megatexture PART 3.
// @purpose Browser-free convergence predicate for the voxel megatexture probe: first-corner resident set must republish within bounded return attempts.
// @status ACTIVE
//
// A dynamic atlas can have more demanded tiles than slots. Once the complete
// demand set is stamped, all four residents are protected for that frame, so
// a return to corner A may first publish a previously-ready overflow wave.
// Equality with the first A resident set is therefore a bounded convergence
// condition, not a valid one-return scheduling oracle.

export const VOXEL_MEGATEXTURE_POOL_SLOTS = Object.freeze([9, 10, 11, 12]);
export const VOXEL_MEGATEXTURE_MAX_RETURN_ATTEMPTS = 4;

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function residentSetsAreDisjoint(left, right) {
  return (
    Array.isArray(left?.resident) &&
    Array.isArray(right?.resident) &&
    left.resident.length > 0 &&
    right.resident.length > 0 &&
    left.resident.every((tile) => !right.resident.includes(tile))
  );
}

/**
 * True only when the exact first-A tiles are resident again after each tile
 * was re-requested and republished into a newer atlas-slot generation.
 * Self-contained by design: the physical probe injects this function into its
 * browser page via `toString()`.
 */
export function voxelMegatextureResidentSetWasRepublished(firstA, candidate) {
  const sameResidentSet =
    Array.isArray(firstA?.resident) &&
    Array.isArray(candidate?.resident) &&
    firstA.resident.length === candidate.resident.length &&
    firstA.resident.every(
      (value, index) => value === candidate.resident[index],
    );
  if (
    !sameResidentSet ||
    !Array.isArray(firstA?.requestSerials) ||
    !Array.isArray(candidate?.requestSerials) ||
    !Array.isArray(firstA?.slotGenerations) ||
    !Array.isArray(candidate?.slotGenerations) ||
    firstA.requestSerials.length !== firstA.resident.length ||
    candidate.requestSerials.length !== candidate.resident.length ||
    firstA.slotGenerations.length !== firstA.resident.length ||
    candidate.slotGenerations.length !== candidate.resident.length
  ) {
    return false;
  }

  for (let index = 0; index < firstA.resident.length; index++) {
    if (
      !Number.isSafeInteger(firstA.requestSerials[index]) ||
      !Number.isSafeInteger(candidate.requestSerials[index]) ||
      candidate.requestSerials[index] <= firstA.requestSerials[index] ||
      !Number.isSafeInteger(firstA.slotGenerations[index]) ||
      !Number.isSafeInteger(candidate.slotGenerations[index]) ||
      candidate.slotGenerations[index] <= firstA.slotGenerations[index]
    ) {
      return false;
    }
  }
  return true;
}

function validatePoolSnapshot(label, snapshot, poolSlots, failures) {
  if (!snapshot || typeof snapshot !== "object") {
    failures.push(`${label} snapshot is absent`);
    return;
  }
  const residentCount = snapshot.resident?.length;
  if (
    !Array.isArray(snapshot.resident) ||
    residentCount !== poolSlots.length ||
    new Set(snapshot.resident ?? []).size !== poolSlots.length ||
    (Array.isArray(snapshot.resident) &&
      snapshot.resident.some(
        (tile) => !Number.isSafeInteger(tile) || tile < 0 || tile >= 64,
      ))
  ) {
    failures.push(`${label} does not contain exactly the capped resident set`);
  }
  if (
    snapshot.slotCount !== 13 ||
    snapshot.l2Dynamic !== true ||
    snapshot.l2PoolSize !== poolSlots.length ||
    !Number.isSafeInteger(snapshot.maxResident) ||
    snapshot.maxResident !== poolSlots.length
  ) {
    failures.push(`${label} has invalid dynamic atlas capacity evidence`);
  }
  if (
    !Number.isSafeInteger(snapshot.demandCount) ||
    !(snapshot.demandCount > poolSlots.length)
  ) {
    failures.push(`${label} does not preserve the over-capacity demand case`);
  }
  if (
    !Number.isSafeInteger(snapshot.evictionCount) ||
    snapshot.evictionCount < 0
  ) {
    failures.push(`${label} has invalid eviction-count evidence`);
  }
  const sortedSlots = Array.isArray(snapshot.slotsUsed)
    ? [...snapshot.slotsUsed].sort((a, b) => a - b)
    : [];
  if (!sameArray(sortedSlots, poolSlots)) {
    failures.push(`${label} does not occupy every pool slot exactly once`);
  }
  for (const [field, values] of [
    ["request serial", snapshot.requestSerials],
    ["slot generation", snapshot.slotGenerations],
  ]) {
    if (
      !Array.isArray(values) ||
      values.length !== residentCount ||
      values.some((value) => !Number.isSafeInteger(value) || value <= 0)
    ) {
      failures.push(`${label} has invalid ${field} evidence`);
    }
  }
}

/**
 * Assess the complete alternating A/B convergence record. Every camera move
 * must replace exactly the four-slot pool. A non-restored A attempt must be
 * followed by an opposite-corner B leg; the final A must carry the exact
 * original resident identities at newer request and publication generations.
 */
export function assessVoxelMegatextureReuploadEvidence(evidence) {
  const failures = [];
  const poolSlots = [...VOXEL_MEGATEXTURE_POOL_SLOTS];
  const firstA = evidence?.firstA;
  const firstB = evidence?.firstB;
  const attempts = evidence?.returnAttempts;

  validatePoolSnapshot("first A", firstA, poolSlots, failures);
  validatePoolSnapshot("first B", firstB, poolSlots, failures);

  if (!residentSetsAreDisjoint(firstA, firstB)) {
    failures.push("opposite corner did not evict the complete first-A set");
  }
  if (firstB?.evictionCount !== firstA?.evictionCount + poolSlots.length) {
    failures.push("first opposite-corner leg did not replace the pool exactly");
  }

  if (
    !Array.isArray(attempts) ||
    attempts.length < 1 ||
    attempts.length > VOXEL_MEGATEXTURE_MAX_RETURN_ATTEMPTS
  ) {
    failures.push("return-attempt record is absent or outside its exact bound");
  } else {
    let previous = firstB;
    let restoredAttempt = -1;
    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index];
      const label = `return A attempt ${index + 1}`;
      validatePoolSnapshot(label, attempt?.a, poolSlots, failures);
      if (
        attempt?.a?.evictionCount !==
        previous?.evictionCount + poolSlots.length
      ) {
        failures.push(`${label} did not replace the pool exactly`);
      }
      if (!residentSetsAreDisjoint(previous, attempt?.a)) {
        failures.push(`${label} retained residents from the opposite corner`);
      }

      const restored = voxelMegatextureResidentSetWasRepublished(
        firstA,
        attempt?.a,
      );
      if (restored) {
        restoredAttempt = index;
        if (index !== attempts.length - 1 || attempt?.b !== null) {
          failures.push("probe did not stop on the first republished A set");
        }
        break;
      }

      validatePoolSnapshot(
        `opposite B attempt ${index + 1}`,
        attempt?.b,
        poolSlots,
        failures,
      );
      if (
        attempt?.b?.evictionCount !==
        attempt?.a?.evictionCount + poolSlots.length
      ) {
        failures.push(
          `opposite B attempt ${index + 1} did not replace the pool exactly`,
        );
      }
      if (!residentSetsAreDisjoint(attempt?.a, attempt?.b)) {
        failures.push(
          `opposite B attempt ${index + 1} retained residents from corner A`,
        );
      }
      previous = attempt?.b;
    }
    if (restoredAttempt < 0) {
      failures.push("original A tiles were never re-requested and republished");
    }
  }

  if (!(evidence?.pixelDiff?.nonBlackA > 500)) {
    failures.push("restored A frame is empty");
  }
  if (!(evidence?.pixelDiff?.mismatchPct < 1.5)) {
    failures.push("restored A frame does not reproduce the first A frame");
  }
  if (evidence?.consoleErrorCount !== 0) {
    failures.push("physical run reported console or page errors");
  }

  return { pass: failures.length === 0, failures };
}
