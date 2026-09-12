// probe-lifecycle-diagnostics.mjs — how a lifecycle failure is described.
//
// @purpose Bounded, hostile-value-safe description of a probe failure: what the rejected value was, which lifecycle occurrences contributed, and whether a refusal is hiding inside an aggregate.
// @status ACTIVE
//
// WHY THIS IS ITS OWN MODULE. `runProbe`'s pre-adoption catch block reads
// `String(error?.stack ?? error)` and is right to: the value it catches came
// from the probe's own descriptor one call away. Under a lifecycle
// (`probe-lifecycle.mjs`) the value it catches is a `ProbeLifecycleError`
// aggregating every failure the run accumulated — a resource that would not
// close, an orderly deadline, a slot release that did not settle — and
// `String(...)` over that reports the aggregate's own one-line message and
// discards all of them. These helpers project the occurrences instead, so a
// `<name>-error.json` says which obligations failed rather than only that one
// did.
//
// EVERY READ IS DEFENSIVE ON PURPOSE. A rejected value is not necessarily an
// `Error`, and is not necessarily co-operative: it can be a Proxy, it can
// throw from a `message` getter, it can be cyclic, it can be enormous. A
// diagnostic that throws while describing a failure replaces the failure, so
// each accessor here is guarded, each traversal is bounded
// (`MAX_FAILURE_DIAGNOSTIC_NODES`), and each string is truncated
// (`MAX_FAILURE_DIAGNOSTIC_LENGTH`).
//
// Adopted (C13-42a) from the unlanded runtime rewrite that produced the
// 2026-09-09 C13-42 runs; extracted to its own file here so the runtime stays
// inside the fork's size rule.

import { ProbeRefusal } from "./probe-refusal.mjs";

const MAX_FAILURE_DIAGNOSTIC_LENGTH = 2048;
const MAX_FAILURE_DIAGNOSTIC_NODES = 64;

function boundFailureDiagnostic(text) {
  if (text.length <= MAX_FAILURE_DIAGNOSTIC_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_FAILURE_DIAGNOSTIC_LENGTH - 1)}…`;
}

function describeFailureValue(value) {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" && Number.isNaN(value)) {
    return "NaN";
  }
  if (typeof value === "string") {
    if (value === "") {
      return '""';
    }
    const excerpt = value.slice(0, 256);
    return `"${excerpt}"${value.length > excerpt.length ? "…" : ""}`;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return `${value}`;
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (typeof value === "symbol") {
    return "a symbol";
  }
  if (typeof value === "function") {
    return "a function";
  }
  return "an object";
}

function safelyInstanceOf(value, constructor) {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}

function ownDataValue(value, key) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return Object.freeze({ found: false, value: undefined });
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, "value")) {
      return Object.freeze({ found: true, value: descriptor.value });
    }
  } catch {
    // Proxies and malformed containers receive the fixed safe fallback.
  }
  return Object.freeze({ found: false, value: undefined });
}

function ownArrayDataValues(value, remaining) {
  try {
    if (!Array.isArray(value)) {
      return null;
    }
  } catch {
    return null;
  }
  const length = ownDataValue(value, "length");
  if (
    !length.found ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    return null;
  }
  const values = [];
  const count = Math.min(length.value, remaining);
  for (let index = 0; index < count; index++) {
    const entry = ownDataValue(value, `${index}`);
    if (entry.found) {
      values.push(entry.value);
    }
  }
  return values;
}

function describeFailureContainer(value) {
  const state = { remaining: MAX_FAILURE_DIAGNOSTIC_NODES, seen: new Set() };

  const visit = (entry) => {
    if (state.remaining < 1) {
      return "diagnostic limit reached";
    }
    state.remaining--;
    if (
      entry === null ||
      (typeof entry !== "object" && typeof entry !== "function")
    ) {
      return describeFailureValue(entry);
    }
    if (state.seen.has(entry)) {
      return "a cyclic failure";
    }
    state.seen.add(entry);

    const parts = [];
    const message = ownDataValue(entry, "message");
    if (message.found && typeof message.value === "string") {
      parts.push(
        message.value.length > 0 ? boundFailureDiagnostic(message.value) : '""',
      );
    }
    for (const key of ["errors", "causes"]) {
      const nested = ownDataValue(entry, key);
      if (!nested.found) {
        continue;
      }
      const values = ownArrayDataValues(nested.value, state.remaining);
      if (values === null) {
        parts.push("diagnostics unavailable");
        continue;
      }
      for (const nestedValue of values) {
        parts.push(visit(nestedValue));
      }
    }
    const primary = ownDataValue(entry, "primaryCause");
    if (primary.found) {
      parts.push(visit(primary.value));
    }
    return parts.length > 0 ? parts.join("; ") : "an object";
  };

  try {
    return boundFailureDiagnostic(visit(value));
  } catch {
    return "diagnostics unavailable";
  }
}

function describeError(error, label) {
  try {
    const stack = error.stack;
    if (typeof stack === "string" && stack.length > 0) {
      return boundFailureDiagnostic(stack);
    }
  } catch {
    // A diagnostic getter cannot replace the failure it was meant to describe.
  }
  try {
    const message = error.message;
    if (typeof message === "string" && message.length > 0) {
      return boundFailureDiagnostic(`${label}: ${message}`);
    }
  } catch {
    // The stable fallback below does not inspect the rejected value.
  }
  return `${label} failed with an Error whose diagnostics are unavailable`;
}

function failureState(error, label) {
  if (safelyInstanceOf(error, Error)) {
    return {
      occurred: true,
      error,
      description: describeError(error, label),
    };
  }
  const normalized = new Error(
    `${label} failed with ${describeFailureValue(error)}`,
    { cause: error },
  );
  return {
    occurred: true,
    error: normalized,
    description: describeError(normalized, label),
  };
}

function projectLifecycleFailures(error) {
  const occurrenceProperty = ownDataValue(error, "failureOccurrences");
  if (!occurrenceProperty.found) {
    return Object.freeze([]);
  }
  const occurrences = ownArrayDataValues(
    occurrenceProperty.value,
    MAX_FAILURE_DIAGNOSTIC_NODES,
  );
  if (occurrences === null) {
    return Object.freeze([]);
  }

  const seen = new Set();
  const records = [];
  for (const entry of occurrences) {
    try {
      const occurred = ownDataValue(entry, "occurred");
      if (!occurred.found || occurred.value !== true) {
        continue;
      }
      const occurrenceProperty = ownDataValue(entry, "occurrence");
      const labelProperty = ownDataValue(entry, "label");
      const rawProperty = ownDataValue(entry, "raw");
      const occurrence = occurrenceProperty.value;
      const label = labelProperty.value;
      if (
        !occurrenceProperty.found ||
        !labelProperty.found ||
        !rawProperty.found ||
        !Number.isSafeInteger(occurrence) ||
        occurrence < 1 ||
        typeof label !== "string" ||
        seen.has(occurrence)
      ) {
        continue;
      }
      seen.add(occurrence);
      const boundedLabel = boundFailureDiagnostic(label);
      records.push(
        Object.freeze({
          occurrence,
          label: boundedLabel,
          diagnostic: boundFailureDiagnostic(
            `${boundedLabel} failed with ${describeFailureValue(rawProperty.value)}`,
          ),
        }),
      );
    } catch {
      // Malformed occurrence metadata cannot replace the lifecycle failure.
    }
  }
  return Object.freeze(records);
}

function appendLifecycleDiagnostics(description, error, lifecycleFailures) {
  if (lifecycleFailures.length === 0) {
    return description;
  }
  const causalDiagnostic = describeFailureContainer(error);
  return boundFailureDiagnostic(
    `${causalDiagnostic}; ${lifecycleFailures
      .map((failure) => failure.diagnostic)
      .join("; ")}; ${description}`,
  );
}

function probeRefusalRecord(error) {
  if (!safelyInstanceOf(error, ProbeRefusal)) {
    return null;
  }
  try {
    const reason = error.reason;
    const message = error.message;
    const details = error.details;
    if (typeof reason !== "string" || typeof message !== "string") {
      return null;
    }
    return { reason, message, details };
  } catch {
    return null;
  }
}

let nextFailureOccurrence = 0;

/**
 * A failure occurrence with a monotonic id. The id is what lets the same
 * failure be reported once even though it is observed on several paths (the
 * work wrapper, the browser close, the lifecycle drain).
 *
 * @param {string} label What was being done.
 * @param {unknown} raw The rejected value.
 * @returns {Readonly<{occurred: true, occurrence: number, label: string, raw: unknown}>} The occurrence.
 */
export function sourceFailure(label, raw) {
  return Object.freeze({
    occurred: true,
    occurrence: ++nextFailureOccurrence,
    label,
    raw,
  });
}

/**
 * Append a failure to `target` unless its occurrence was already appended.
 *
 * @param {Array<object>} target Sink.
 * @param {Set<number>} seenOccurrences Occurrence ids already appended.
 * @param {object} failure The occurrence.
 * @returns {void}
 */
export function appendOnce(target, seenOccurrences, failure) {
  if (!failure?.occurred || seenOccurrences.has(failure.occurrence)) {
    return;
  }
  seenOccurrences.add(failure.occurrence);
  target.push(failure);
}

export {
  appendLifecycleDiagnostics,
  boundFailureDiagnostic,
  describeFailureContainer,
  describeFailureValue,
  failureState,
  probeRefusalRecord,
  projectLifecycleFailures,
  safelyInstanceOf,
};
