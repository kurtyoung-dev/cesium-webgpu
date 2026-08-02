const ISSUE_EVENT_TYPES = new Set(["issued", "reissued"]);
const TERMINAL_EVENT_TYPES = new Set([
  "completed",
  "failed",
  "cancelled-settled",
  "resolved-without-content",
]);
const BYTE_TOTAL_NAMES = Object.freeze([
  "transferBytes",
  "encodedBodyBytes",
  "decodedBodyBytes",
]);
const COMPARISON_MISMATCH_LIMIT = 64;
const HASH_SEED_A = 0x811c9dc5;
const HASH_SEED_B = 0x9e3779b9;
const HASH_PRIME = 0x01000193;

function stableRequestMapKey(tile, contentSlot, requestSerial) {
  return JSON.stringify([tile, contentSlot, requestSerial]);
}

function stableRequestId(tile, contentSlot, requestSerial) {
  return `${tile}::${contentSlot}::${requestSerial}`;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validTileIdentity(value) {
  return (
    typeof value === "string" && value.length > 0 && value !== "unidentified"
  );
}

function eventRequestSerial(event) {
  return event?.requestSerial ?? event?.issueCount ?? null;
}

function eventContentSlot(event) {
  return event?.contentSlot ?? "single";
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function lifecycleToken(requestSerial, phase) {
  return `request:${requestSerial}:${phase}`;
}

function pushChronology(chronologies, tile, token) {
  let chronology = chronologies.get(tile);
  if (!chronology) {
    chronology = [];
    chronologies.set(tile, chronology);
  }
  chronology.push(token);
}

function mixHash(hash, text) {
  let result = hash >>> 0;
  for (let index = 0; index < text.length; index++) {
    result ^= text.charCodeAt(index);
    result = Math.imul(result, HASH_PRIME) >>> 0;
  }
  return Math.imul(result ^ 0xff, HASH_PRIME) >>> 0;
}

function signatureFor(values) {
  let hashA = HASH_SEED_A;
  let hashB = HASH_SEED_B;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    hashA = mixHash(hashA, value);
    hashB = mixHash(hashB ^ Math.imul(index + 1, 0x27d4eb2d), value);
  }
  const hex = (value) => (value >>> 0).toString(16).padStart(8, "0");
  return `${hex(hashA)}-${hex(hashB)}`;
}

function summarizeFinite(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    return null;
  }
  const total = finite.reduce((sum, value) => sum + value, 0);
  return {
    count: finite.length,
    min: Math.min(...finite),
    max: Math.max(...finite),
    avg: total / finite.length,
  };
}

function compareStableValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summarizeEndpoint(ledger) {
  return {
    schemaVersion: ledger?.schemaVersion ?? null,
    valid: ledger?.valid === true,
    complete: ledger?.complete === true,
    eventCount: ledger?.eventCount ?? null,
    requestCount: ledger?.requestCount ?? null,
    deferralCount: ledger?.deferralCount ?? null,
    openRequestCount: ledger?.openRequestCount ?? null,
    signature: ledger?.signature ?? null,
    reasons: Array.isArray(ledger?.reasons) ? [...ledger.reasons] : [],
    coverage: ledger?.coverage ? { ...ledger.coverage } : null,
  };
}

/**
 * Normalize one renderer leg's raw C11-205 lifecycle events into stable,
 * renderer-independent request identities.
 *
 * `requestId` is deliberately used only to join events within one endpoint.
 * Cross-leg identity is `(tile path, content slot, per-tile request serial)`.
 * Global event order, timestamps, and absolute frame numbers are retained as
 * latency evidence but are not folded into the stable request signature.
 *
 * @param {object} diagnostics Raw representative tileset lifecycle snapshot.
 * @returns {object} Stable request ledger.
 */
function createRepresentativeTilesetRequestLedgerV1(diagnostics) {
  const reasons = [];
  const events = diagnostics?.events;
  if (!Array.isArray(events)) {
    return {
      schemaVersion: 1,
      valid: false,
      complete: false,
      reasons: ["request lifecycle events are missing"],
      eventCount: null,
      requestCount: 0,
      deferralCount: 0,
      openRequestCount: 0,
      signature: null,
      coverage: {
        singleContentObserved: false,
        multipleContentObserved: false,
        multipleContentSupported: false,
      },
      requests: [],
      tileChronologies: [],
      latencyFrames: { settle: null, ready: null },
      byteTotals: Object.fromEntries(
        BYTE_TOTAL_NAMES.map((name) => [name, null]),
      ),
    };
  }
  if (diagnostics.eventsTruncated === true) {
    addReason(reasons, "request lifecycle event stream was truncated");
  }

  const requestsByLocalId = new Map();
  const requestsByStableKey = new Map();
  const serialsByTileSlot = new Map();
  const attemptsByTile = new Map();
  const chronologies = new Map();
  let deferralCount = 0;
  let singleContentObserved = false;
  let multipleContentObserved = false;

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!event || typeof event !== "object") {
      addReason(reasons, `request event ${index} is not an object`);
      continue;
    }
    if (event.sequence !== index) {
      addReason(
        reasons,
        `request event sequence is not contiguous at index ${index}`,
      );
    }

    const tile = event.tile;
    const contentKind = event.contentKind ?? "single";
    if (contentKind === "multiple") {
      multipleContentObserved = true;
      addReason(
        reasons,
        "multiple-content request coverage is unsupported by the single-content ledger",
      );
    } else if (contentKind === "single") {
      singleContentObserved = true;
    } else {
      addReason(reasons, `request event ${index} has unknown content kind`);
    }
    if (!validTileIdentity(tile)) {
      addReason(reasons, `request event ${index} has no stable tile identity`);
    }

    if (event.type === "scheduling-deferred") {
      deferralCount++;
      const attemptSerial = event.attemptSerial;
      if (!isPositiveInteger(attemptSerial)) {
        addReason(
          reasons,
          `scheduling deferral for ${tile ?? "unknown tile"} lacks an attempt serial`,
        );
      } else if (validTileIdentity(tile)) {
        const attempts = attemptsByTile.get(tile) ?? new Set();
        if (attempts.has(attemptSerial)) {
          addReason(
            reasons,
            `tile ${tile} has duplicate attempt serial ${attemptSerial}`,
          );
        }
        attempts.add(attemptSerial);
        attemptsByTile.set(tile, attempts);
        pushChronology(
          chronologies,
          tile,
          `attempt:${attemptSerial}:scheduling-deferred`,
        );
      }
      continue;
    }

    if (ISSUE_EVENT_TYPES.has(event.type)) {
      const localRequestId = event.requestId;
      const requestSerial = eventRequestSerial(event);
      const contentSlot = eventContentSlot(event);
      const attemptSerial = event.attemptSerial ?? requestSerial;
      if (!isPositiveInteger(localRequestId)) {
        addReason(
          reasons,
          `issued request for ${tile ?? "unknown tile"} lacks a local request id`,
        );
        continue;
      }
      if (requestsByLocalId.has(localRequestId)) {
        addReason(reasons, `duplicate local request id ${localRequestId}`);
        continue;
      }
      if (!isPositiveInteger(requestSerial)) {
        addReason(
          reasons,
          `request ${localRequestId} lacks a per-tile request serial`,
        );
        continue;
      }
      if (!isPositiveInteger(attemptSerial)) {
        addReason(
          reasons,
          `request ${localRequestId} lacks a per-tile attempt serial`,
        );
      }
      if (typeof contentSlot !== "string" || contentSlot.length === 0) {
        addReason(reasons, `request ${localRequestId} has no content slot`);
      }
      if (typeof event.url !== "string" || event.url.trim().length === 0) {
        addReason(reasons, `request ${localRequestId} has no request URL`);
      }
      if (
        event.requestObjectObserved === false ||
        (contentKind === "multiple" && event.requestObjectObserved !== true)
      ) {
        addReason(
          reasons,
          `request ${localRequestId} has no observable request object`,
        );
      }
      if (
        (requestSerial === 1 && event.type !== "issued") ||
        (requestSerial > 1 && event.type !== "reissued")
      ) {
        addReason(
          reasons,
          `request ${localRequestId} type does not match serial ${requestSerial}`,
        );
      }

      const stableMapKey = stableRequestMapKey(
        tile,
        contentSlot,
        requestSerial,
      );
      if (requestsByStableKey.has(stableMapKey)) {
        addReason(
          reasons,
          `duplicate stable request identity ${stableRequestId(tile, contentSlot, requestSerial)}`,
        );
        continue;
      }
      const request = {
        id: stableRequestId(tile, contentSlot, requestSerial),
        tile,
        contentKind,
        contentSlot,
        requestSerial,
        attemptSerial,
        localRequestId,
        url: typeof event.url === "string" ? event.url : null,
        issueType: event.type,
        issueFrameNumber: Number.isFinite(event.frameNumber)
          ? event.frameNumber
          : null,
        terminalType: null,
        terminalFrameNumber: null,
        cancelled: false,
        ready: false,
        readyFrameNumber: null,
        lifecycle: [event.type],
        bytes: null,
      };
      requestsByLocalId.set(localRequestId, request);
      requestsByStableKey.set(stableMapKey, request);

      const tileSlotKey = JSON.stringify([tile, contentSlot]);
      const serials = serialsByTileSlot.get(tileSlotKey) ?? new Set();
      serials.add(requestSerial);
      serialsByTileSlot.set(tileSlotKey, serials);
      if (isPositiveInteger(attemptSerial) && validTileIdentity(tile)) {
        const attempts = attemptsByTile.get(tile) ?? new Set();
        if (attempts.has(attemptSerial)) {
          addReason(
            reasons,
            `tile ${tile} has duplicate attempt serial ${attemptSerial}`,
          );
        }
        attempts.add(attemptSerial);
        attemptsByTile.set(tile, attempts);
      }
      if (validTileIdentity(tile)) {
        pushChronology(
          chronologies,
          tile,
          lifecycleToken(requestSerial, event.type),
        );
      }
      continue;
    }

    if (
      event.type !== "cancelled" &&
      event.type !== "ready" &&
      !TERMINAL_EVENT_TYPES.has(event.type)
    ) {
      addReason(
        reasons,
        `request event ${index} has unknown type ${event.type}`,
      );
      continue;
    }
    const request = requestsByLocalId.get(event.requestId);
    if (!request) {
      addReason(
        reasons,
        `${event.type} event ${index} has no matching issued request`,
      );
      continue;
    }
    const eventSerial = eventRequestSerial(event);
    if (eventSerial !== null && eventSerial !== request.requestSerial) {
      addReason(
        reasons,
        `request ${event.requestId} changed serial during ${event.type}`,
      );
    }
    if (validTileIdentity(tile) && tile !== request.tile) {
      addReason(
        reasons,
        `request ${event.requestId} changed tile identity during ${event.type}`,
      );
    }
    if (eventContentSlot(event) !== request.contentSlot) {
      addReason(
        reasons,
        `request ${event.requestId} changed content slot during ${event.type}`,
      );
    }
    if ((event.contentKind ?? "single") !== request.contentKind) {
      addReason(
        reasons,
        `request ${event.requestId} changed content kind during ${event.type}`,
      );
    }
    if (
      event.attemptSerial !== undefined &&
      event.attemptSerial !== null &&
      event.attemptSerial !== request.attemptSerial
    ) {
      addReason(
        reasons,
        `request ${event.requestId} changed attempt serial during ${event.type}`,
      );
    }

    if (event.type === "cancelled") {
      if (request.terminalType !== null || request.ready) {
        addReason(
          reasons,
          `request ${request.id} was cancelled after it settled`,
        );
      }
      if (request.cancelled) {
        addReason(
          reasons,
          `request ${request.id} was cancelled more than once`,
        );
      }
      request.cancelled = true;
    } else if (event.type === "ready") {
      if (request.terminalType !== "completed") {
        addReason(
          reasons,
          `request ${request.id} became ready before successful completion`,
        );
      }
      if (request.ready) {
        addReason(reasons, `request ${request.id} became ready more than once`);
      }
      request.ready = true;
      request.readyFrameNumber = Number.isFinite(event.frameNumber)
        ? event.frameNumber
        : null;
    } else {
      if (request.ready) {
        addReason(
          reasons,
          `request ${request.id} settled after it became ready`,
        );
      }
      if (event.type === "cancelled-settled" && !request.cancelled) {
        addReason(
          reasons,
          `request ${request.id} settled as cancelled before its cancellation event`,
        );
      }
      if (request.terminalType !== null) {
        addReason(
          reasons,
          `request ${request.id} has multiple terminal events`,
        );
      }
      request.terminalType = event.type;
      request.terminalFrameNumber = Number.isFinite(event.frameNumber)
        ? event.frameNumber
        : null;
      request.bytes = event.bytes ? { ...event.bytes } : null;
    }
    request.lifecycle.push(event.type);
    if (validTileIdentity(request.tile)) {
      pushChronology(
        chronologies,
        request.tile,
        lifecycleToken(request.requestSerial, event.type),
      );
    }
  }

  for (const [tileSlotKey, serials] of serialsByTileSlot) {
    const sorted = [...serials].sort((left, right) => left - right);
    for (let index = 0; index < sorted.length; index++) {
      if (sorted[index] !== index + 1) {
        addReason(
          reasons,
          `request serials are not contiguous for ${tileSlotKey}`,
        );
        break;
      }
    }
  }
  for (const [tile, attempts] of attemptsByTile) {
    const sorted = [...attempts].sort((left, right) => left - right);
    for (let index = 0; index < sorted.length; index++) {
      if (sorted[index] !== index + 1) {
        addReason(reasons, `attempt serials are not contiguous for ${tile}`);
        break;
      }
    }
  }

  const requests = [...requestsByStableKey.values()].sort(
    (left, right) =>
      left.tile.localeCompare(right.tile) ||
      left.contentSlot.localeCompare(right.contentSlot) ||
      left.requestSerial - right.requestSerial,
  );
  if (requests.length === 0) {
    addReason(reasons, "request lifecycle event stream has no issued requests");
  }
  for (const request of requests) {
    if (request.ready && request.terminalType !== "completed") {
      addReason(
        reasons,
        `request ${request.id} became ready without a completed terminal event`,
      );
    }
    if (
      request.ready &&
      request.lifecycle.indexOf("ready") <
        request.lifecycle.indexOf("completed")
    ) {
      addReason(
        reasons,
        `request ${request.id} became ready before completion`,
      );
    }
    if (
      request.terminalType === "cancelled-settled" &&
      request.cancelled !== true
    ) {
      addReason(
        reasons,
        `request ${request.id} settled as cancelled without a cancellation event`,
      );
    }
  }
  const tileChronologies = [...chronologies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tile, chronology]) => ({ tile, chronology: [...chronology] }));
  const openRequestCount = requests.filter(
    (request) => request.terminalType === null,
  ).length;
  const eventCount = (type) =>
    events.filter((event) => event?.type === type).length;
  const derivedTotals = {
    requestAttempts:
      eventCount("issued") + eventCount("reissued") + deferralCount,
    requestsIssued: eventCount("issued") + eventCount("reissued"),
    requestSchedulingDeferrals: deferralCount,
    requestsCancelled: eventCount("cancelled"),
    requestsReissued: eventCount("reissued"),
    requestsReissuedAfterCancellation: requests.filter((request) => {
      if (request.requestSerial <= 1) {
        return false;
      }
      const previous = requestsByStableKey.get(
        stableRequestMapKey(
          request.tile,
          request.contentSlot,
          request.requestSerial - 1,
        ),
      );
      return previous?.terminalType === "cancelled-settled";
    }).length,
    requestsCompleted: eventCount("completed"),
    requestsFailed: eventCount("failed"),
    requestsResolvedWithoutContent:
      eventCount("cancelled-settled") + eventCount("resolved-without-content"),
    tileReadyEvents: eventCount("ready"),
  };
  for (const [name, expected] of Object.entries(derivedTotals)) {
    const actual = diagnostics?.totals?.[name];
    if (!Number.isInteger(actual) || actual < 0) {
      addReason(
        reasons,
        `request lifecycle total ${name} is missing or invalid`,
      );
    } else if (actual !== expected) {
      addReason(
        reasons,
        `request lifecycle total ${name} disagrees with events (${actual}/${expected})`,
      );
    }
  }
  if (
    Number.isInteger(diagnostics?.totals?.multipleContentRequestAttempts) &&
    diagnostics.totals.multipleContentRequestAttempts !==
      events
        .filter((event) => event?.contentKind === "multiple")
        .filter(
          (event) =>
            event.type === "issued" ||
            event.type === "reissued" ||
            event.type === "scheduling-deferred",
        ).length
  ) {
    addReason(
      reasons,
      "multiple-content request-attempt total disagrees with events",
    );
  }
  for (const name of BYTE_TOTAL_NAMES) {
    const value = diagnostics?.totals?.[name];
    if (!Number.isFinite(value) || value < 0) {
      addReason(
        reasons,
        `request lifecycle byte total ${name} is missing or invalid`,
      );
    }
  }
  const signatureValues = [
    ...requests.map((request) =>
      JSON.stringify([
        request.tile,
        request.contentSlot,
        request.requestSerial,
        request.attemptSerial,
        request.url,
        request.lifecycle,
      ]),
    ),
    ...tileChronologies.map((entry) =>
      JSON.stringify([entry.tile, entry.chronology]),
    ),
  ];
  const settleLatencies = requests.map((request) =>
    Number.isFinite(request.issueFrameNumber) &&
    Number.isFinite(request.terminalFrameNumber)
      ? request.terminalFrameNumber - request.issueFrameNumber
      : null,
  );
  const readyLatencies = requests.map((request) =>
    Number.isFinite(request.issueFrameNumber) &&
    Number.isFinite(request.readyFrameNumber)
      ? request.readyFrameNumber - request.issueFrameNumber
      : null,
  );
  const byteTotals = Object.fromEntries(
    BYTE_TOTAL_NAMES.map((name) => [
      name,
      Number.isFinite(diagnostics?.totals?.[name]) &&
      diagnostics.totals[name] >= 0
        ? diagnostics.totals[name]
        : null,
    ]),
  );

  return {
    schemaVersion: 1,
    valid: reasons.length === 0,
    complete: reasons.length === 0,
    reasons,
    eventCount: events.length,
    requestCount: requests.length,
    deferralCount,
    openRequestCount,
    signature: reasons.length === 0 ? signatureFor(signatureValues) : null,
    coverage: {
      singleContentObserved,
      multipleContentObserved,
      multipleContentSupported: false,
    },
    requests,
    tileChronologies,
    latencyFrames: {
      settle: summarizeFinite(settleLatencies),
      ready: summarizeFinite(readyLatencies),
    },
    byteTotals,
  };
}

const V2_CONTENT_OUTCOME_TYPES = new Set([
  "content-created",
  "content-factory-failed",
  "content-discarded",
  "content-unavailable",
]);
const V2_MODEL_EVENT_TYPES = new Set([
  "model-ready",
  "content-ready",
  "model-destroyed-before-ready",
]);

function emptyRequestLedger(schemaVersion, reason) {
  return {
    schemaVersion,
    valid: false,
    complete: false,
    reasons: [reason],
    eventCount: null,
    requestCount: 0,
    deferralCount: 0,
    openRequestCount: 0,
    signature: null,
    coverage: {
      singleContentObserved: false,
      multipleContentObserved: false,
      multipleContentSupported: schemaVersion === 2,
      modelReadinessObserved: false,
    },
    requests: [],
    tileChronologies: [],
    readiness: null,
    latencyFrames: { settle: null, ready: null },
    byteTotals: Object.fromEntries(
      BYTE_TOTAL_NAMES.map((name) => [name, null]),
    ),
  };
}

function stableModelId(tile, contentSlot, requestSerial, modelPath) {
  return `${stableRequestId(tile, contentSlot, requestSerial)}::${modelPath}`;
}

function createRepresentativeTilesetRequestLedgerV2(diagnostics) {
  const events = diagnostics?.events;
  if (!Array.isArray(events)) {
    return emptyRequestLedger(2, "request lifecycle events are missing");
  }

  const reasons = [];
  if (diagnostics.eventsTruncated === true) {
    addReason(reasons, "request lifecycle event stream was truncated");
  }

  const requestsByLocalId = new Map();
  const requestsByStableKey = new Map();
  const requestsByStableIdDuringEvents = new Map();
  const serialsByTileSlot = new Map();
  const attemptsByTileSlot = new Map();
  const multipleGroups = new Map();
  const chronologies = new Map();
  const contentOutcomesByRequestId = new Map();
  const modelsById = new Map();
  const latestIssuedMultipleGroupByTile = new Map();
  const tileReadyEvents = [];
  const tileReadyKeys = new Set();
  let deferralCount = 0;
  let singleContentObserved = false;
  let multipleContentObserved = false;

  // A multiple-content group's slots can settle in either network order.
  // Keep chronology per stable slot so cross-leg evidence never treats that
  // irrelevant global interleaving as a lifecycle mismatch.
  const pushSlotChronology = (tile, contentSlot, token) =>
    pushChronology(chronologies, JSON.stringify([tile, contentSlot]), token);

  const observeMultipleGroupAttempt = (event, index) => {
    if (event.contentKind !== "multiple") {
      return;
    }
    if (!isPositiveInteger(event.groupSerial)) {
      addReason(
        reasons,
        `multiple-content request event ${index} has no group serial`,
      );
      return;
    }
    if (!isPositiveInteger(event.groupSize)) {
      addReason(
        reasons,
        `multiple-content request event ${index} has no group size`,
      );
      return;
    }
    const key = JSON.stringify([event.tile, event.groupSerial]);
    const group = multipleGroups.get(key) ?? {
      tile: event.tile,
      groupSerial: event.groupSerial,
      groupSize: event.groupSize,
      contentSlots: new Set(),
    };
    if (group.groupSize !== event.groupSize) {
      addReason(reasons, `multiple-content request group ${key} changed size`);
    }
    if (group.contentSlots.has(eventContentSlot(event))) {
      addReason(
        reasons,
        `multiple-content request group ${key} repeats slot ${eventContentSlot(event)}`,
      );
    }
    group.contentSlots.add(eventContentSlot(event));
    multipleGroups.set(key, group);
  };

  const observeContentKind = (event, index) => {
    const contentKind = event.contentKind ?? "single";
    if (contentKind === "single") {
      singleContentObserved = true;
    } else if (contentKind === "multiple") {
      multipleContentObserved = true;
    } else {
      addReason(reasons, `request event ${index} has unknown content kind`);
    }
    return contentKind;
  };

  const joinRequest = (event, index) => {
    const request = requestsByLocalId.get(event.requestId);
    if (!request) {
      addReason(
        reasons,
        `${event.type} event ${index} has no matching issued request`,
      );
      return null;
    }
    if (eventRequestSerial(event) !== request.requestSerial) {
      addReason(
        reasons,
        `request ${event.requestId} changed serial during ${event.type}`,
      );
    }
    if (event.tile !== request.tile) {
      addReason(
        reasons,
        `request ${event.requestId} changed tile identity during ${event.type}`,
      );
    }
    if (eventContentSlot(event) !== request.contentSlot) {
      addReason(
        reasons,
        `request ${event.requestId} changed content slot during ${event.type}`,
      );
    }
    if ((event.contentKind ?? "single") !== request.contentKind) {
      addReason(
        reasons,
        `request ${event.requestId} changed content kind during ${event.type}`,
      );
    }
    if (
      event.attemptSerial !== undefined &&
      event.attemptSerial !== null &&
      event.attemptSerial !== request.attemptSerial
    ) {
      addReason(
        reasons,
        `request ${event.requestId} changed attempt serial during ${event.type}`,
      );
    }
    if (
      (request.contentKind === "multiple" ||
        (event.groupSerial !== undefined && event.groupSerial !== null)) &&
      event.groupSerial !== request.groupSerial
    ) {
      addReason(
        reasons,
        `request ${event.requestId} changed group serial during ${event.type}`,
      );
    }
    if (
      (request.contentKind === "multiple" ||
        (event.groupSize !== undefined && event.groupSize !== null)) &&
      event.groupSize !== request.groupSize
    ) {
      addReason(
        reasons,
        `request ${event.requestId} changed group size during ${event.type}`,
      );
    }
    return request;
  };

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!event || typeof event !== "object") {
      addReason(reasons, `request event ${index} is not an object`);
      continue;
    }
    if (event.sequence !== index) {
      addReason(
        reasons,
        `request event sequence is not contiguous at index ${index}`,
      );
    }

    const tile = event.tile;
    if (!validTileIdentity(tile)) {
      addReason(reasons, `request event ${index} has no stable tile identity`);
    }
    const contentKind = observeContentKind(event, index);
    const contentSlot = eventContentSlot(event);
    const tileSlotKey = JSON.stringify([tile, contentSlot]);

    if (event.type === "instrumentation-ambiguity") {
      addReason(
        reasons,
        `instrumentation ambiguity at ${tile ?? "unknown tile"}: ${event.reason || "unspecified"}`,
      );
      continue;
    }

    if (event.type === "scheduling-deferred") {
      deferralCount++;
      if (typeof contentSlot !== "string" || contentSlot.length === 0) {
        addReason(reasons, `request event ${index} has no content slot`);
      }
      observeMultipleGroupAttempt(event, index);
      if (!isPositiveInteger(event.attemptSerial)) {
        addReason(
          reasons,
          `scheduling deferral for ${tile ?? "unknown tile"}/${contentSlot} lacks an attempt serial`,
        );
      } else {
        const attempts = attemptsByTileSlot.get(tileSlotKey) ?? new Set();
        if (attempts.has(event.attemptSerial)) {
          addReason(
            reasons,
            `tile slot ${tileSlotKey} has duplicate attempt serial ${event.attemptSerial}`,
          );
        }
        attempts.add(event.attemptSerial);
        attemptsByTileSlot.set(tileSlotKey, attempts);
        pushSlotChronology(
          tile,
          contentSlot,
          `attempt:${event.attemptSerial}:scheduling-deferred`,
        );
      }
      continue;
    }

    if (ISSUE_EVENT_TYPES.has(event.type)) {
      observeMultipleGroupAttempt(event, index);
      const requestSerial = eventRequestSerial(event);
      const attemptSerial = event.attemptSerial ?? requestSerial;
      if (!isPositiveInteger(event.requestId)) {
        addReason(
          reasons,
          `issued request for ${tile ?? "unknown tile"} lacks a local request id`,
        );
        continue;
      }
      if (requestsByLocalId.has(event.requestId)) {
        addReason(reasons, `duplicate local request id ${event.requestId}`);
        continue;
      }
      if (!isPositiveInteger(requestSerial)) {
        addReason(
          reasons,
          `request ${event.requestId} lacks a per-slot request serial`,
        );
        continue;
      }
      if (!isPositiveInteger(attemptSerial)) {
        addReason(
          reasons,
          `request ${event.requestId} lacks a per-slot attempt serial`,
        );
      }
      if (typeof contentSlot !== "string" || contentSlot.length === 0) {
        addReason(reasons, `request ${event.requestId} has no content slot`);
      }
      if (typeof event.url !== "string" || event.url.trim().length === 0) {
        addReason(reasons, `request ${event.requestId} has no request URL`);
      }
      if (event.requestObjectObserved !== true) {
        addReason(
          reasons,
          `request ${event.requestId} has no observable request object`,
        );
      }
      if (
        (requestSerial === 1 && event.type !== "issued") ||
        (requestSerial > 1 && event.type !== "reissued")
      ) {
        addReason(
          reasons,
          `request ${event.requestId} type does not match serial ${requestSerial}`,
        );
      }

      const stableMapKey = stableRequestMapKey(
        tile,
        contentSlot,
        requestSerial,
      );
      if (requestsByStableKey.has(stableMapKey)) {
        addReason(
          reasons,
          `duplicate stable request identity ${stableRequestId(tile, contentSlot, requestSerial)}`,
        );
        continue;
      }
      const request = {
        id: stableRequestId(tile, contentSlot, requestSerial),
        tile,
        contentKind,
        contentSlot,
        requestSerial,
        attemptSerial,
        groupSerial: event.groupSerial ?? null,
        groupSize: event.groupSize ?? null,
        localRequestId: event.requestId,
        url: typeof event.url === "string" ? event.url : null,
        issueType: event.type,
        issueFrameNumber: Number.isFinite(event.frameNumber)
          ? event.frameNumber
          : null,
        terminalType: null,
        terminalFrameNumber: null,
        cancelled: false,
        ready: false,
        readyFrameNumber: null,
        lifecycle: [event.type],
        bytes: null,
      };
      requestsByLocalId.set(event.requestId, request);
      requestsByStableKey.set(stableMapKey, request);
      requestsByStableIdDuringEvents.set(request.id, request);
      if (contentKind === "multiple" && isPositiveInteger(event.groupSerial)) {
        latestIssuedMultipleGroupByTile.set(
          tile,
          Math.max(
            latestIssuedMultipleGroupByTile.get(tile) ?? 0,
            event.groupSerial,
          ),
        );
      }

      const serials = serialsByTileSlot.get(tileSlotKey) ?? new Set();
      serials.add(requestSerial);
      serialsByTileSlot.set(tileSlotKey, serials);
      const attempts = attemptsByTileSlot.get(tileSlotKey) ?? new Set();
      if (attempts.has(attemptSerial)) {
        addReason(
          reasons,
          `tile slot ${tileSlotKey} has duplicate attempt serial ${attemptSerial}`,
        );
      }
      attempts.add(attemptSerial);
      attemptsByTileSlot.set(tileSlotKey, attempts);
      pushSlotChronology(
        tile,
        contentSlot,
        lifecycleToken(requestSerial, event.type),
      );
      continue;
    }

    if (event.type === "cancel-requested-noop") {
      const request = joinRequest(event, index);
      if (!request) {
        continue;
      }
      if (request.terminalType == null) {
        addReason(
          reasons,
          `request ${request.id} recorded a cancellation no-op before settlement`,
        );
      }
      if (event.terminalType !== request.terminalType) {
        addReason(
          reasons,
          `request ${request.id} cancellation no-op changed its terminal type`,
        );
      }
      if (request.lifecycle.includes("cancel-requested-noop")) {
        addReason(
          reasons,
          `request ${request.id} recorded more than one cancellation no-op`,
        );
      }
      request.lifecycle.push(event.type);
      pushSlotChronology(
        tile,
        request.contentSlot,
        lifecycleToken(request.requestSerial, event.type),
      );
      continue;
    }

    if (event.type === "cancelled" || TERMINAL_EVENT_TYPES.has(event.type)) {
      const request = joinRequest(event, index);
      if (!request) {
        continue;
      }
      if (event.type === "cancelled") {
        if (request.terminalType !== null) {
          addReason(
            reasons,
            `request ${request.id} was cancelled after it settled`,
          );
        }
        if (request.cancelled) {
          addReason(
            reasons,
            `request ${request.id} was cancelled more than once`,
          );
        }
        request.cancelled = true;
      } else {
        if (event.type === "cancelled-settled" && !request.cancelled) {
          addReason(
            reasons,
            `request ${request.id} settled as cancelled before its cancellation event`,
          );
        }
        if (request.terminalType !== null) {
          addReason(
            reasons,
            `request ${request.id} has multiple terminal events`,
          );
        }
        request.terminalType = event.type;
        request.terminalFrameNumber = Number.isFinite(event.frameNumber)
          ? event.frameNumber
          : null;
        request.bytes = event.bytes ? { ...event.bytes } : null;
      }
      request.lifecycle.push(event.type);
      pushSlotChronology(
        tile,
        request.contentSlot,
        lifecycleToken(request.requestSerial, event.type),
      );
      continue;
    }

    if (V2_CONTENT_OUTCOME_TYPES.has(event.type)) {
      const request = joinRequest(event, index);
      if (!request) {
        continue;
      }
      if (contentOutcomesByRequestId.has(request.localRequestId)) {
        addReason(
          reasons,
          `request ${request.id} has multiple content outcomes`,
        );
        continue;
      }
      if (request.terminalType === null) {
        addReason(
          reasons,
          `request ${request.id} produced ${event.type} before settlement`,
        );
      }
      if (
        (event.type === "content-created" ||
          event.type === "content-factory-failed") &&
        request.terminalType !== "completed"
      ) {
        addReason(
          reasons,
          `request ${request.id} produced ${event.type} without successful completion`,
        );
      }
      const modelPaths = Array.isArray(event.modelPaths)
        ? [...event.modelPaths]
        : [];
      if (new Set(modelPaths).size !== modelPaths.length) {
        addReason(reasons, `request ${request.id} has duplicate model paths`);
      }
      if (
        modelPaths.some((path) => typeof path !== "string" || path.length === 0)
      ) {
        addReason(reasons, `request ${request.id} has an invalid model path`);
      }
      if (
        event.type === "content-created" &&
        event.contentType === "Model3DTileContent" &&
        (modelPaths.length !== 1 || modelPaths[0] !== "model")
      ) {
        addReason(
          reasons,
          `request ${request.id} created Model3DTileContent without its canonical model path`,
        );
      }
      contentOutcomesByRequestId.set(request.localRequestId, {
        requestId: request.id,
        tile: request.tile,
        contentSlot: request.contentSlot,
        requestSerial: request.requestSerial,
        type: event.type,
        contentType: event.contentType ?? null,
        modelPaths: [...modelPaths].sort(),
      });
      request.lifecycle.push(event.type);
      pushSlotChronology(
        tile,
        request.contentSlot,
        lifecycleToken(request.requestSerial, event.type),
      );
      continue;
    }

    if (V2_MODEL_EVENT_TYPES.has(event.type)) {
      const request = joinRequest(event, index);
      if (!request) {
        continue;
      }
      if (typeof event.modelPath !== "string" || event.modelPath.length === 0) {
        addReason(reasons, `${event.type} event ${index} has no model path`);
        continue;
      }
      const outcome = contentOutcomesByRequestId.get(request.localRequestId);
      if (outcome?.type !== "content-created") {
        addReason(
          reasons,
          `${event.type} event ${index} occurred before content-created`,
        );
        continue;
      }
      if (!outcome.modelPaths.includes(event.modelPath)) {
        addReason(
          reasons,
          `${event.type} event ${index} references a model path not declared by content-created`,
        );
        continue;
      }
      const id = stableModelId(
        request.tile,
        request.contentSlot,
        request.requestSerial,
        event.modelPath,
      );
      if (event.modelId !== id) {
        addReason(
          reasons,
          `${event.type} event ${index} has an unstable model id`,
        );
      }
      const model = modelsById.get(id) ?? {
        id,
        requestId: request.id,
        tile: request.tile,
        contentSlot: request.contentSlot,
        requestSerial: request.requestSerial,
        modelPath: event.modelPath,
        modelReady: false,
        contentReady: false,
        destroyedBeforeReady: false,
        lifecycle: [],
      };
      const property =
        event.type === "model-ready"
          ? "modelReady"
          : event.type === "content-ready"
            ? "contentReady"
            : "destroyedBeforeReady";
      if (event.type === "content-ready" && !model.modelReady) {
        addReason(
          reasons,
          `model ${id} emitted content-ready before model-ready`,
        );
      }
      if (
        event.type === "model-destroyed-before-ready" &&
        (model.modelReady || model.contentReady)
      ) {
        addReason(
          reasons,
          `model ${id} was destroyed-before-ready after becoming ready`,
        );
      }
      if (model[property]) {
        addReason(reasons, `model ${id} emitted ${event.type} more than once`);
      }
      model[property] = true;
      model.lifecycle.push(event.type);
      modelsById.set(id, model);
      pushSlotChronology(
        tile,
        request.contentSlot,
        `request:${request.requestSerial}:model:${event.modelPath}:${event.type}`,
      );
      continue;
    }

    if (event.type === "tile-ready") {
      if (!Array.isArray(event.requests) || event.requests.length === 0) {
        addReason(
          reasons,
          `tile-ready event ${index} has no request identities`,
        );
        continue;
      }
      const stableRequests = [];
      const seen = new Set();
      const groupSerials = new Set();
      for (const identity of event.requests) {
        const key = stableRequestMapKey(
          tile,
          identity?.contentSlot,
          identity?.requestSerial,
        );
        const request = requestsByStableKey.get(key);
        if (!request) {
          addReason(
            reasons,
            `tile-ready event ${index} references an unknown request`,
          );
          continue;
        }
        if (seen.has(request.id)) {
          addReason(
            reasons,
            `tile-ready event ${index} repeats request ${request.id}`,
          );
          continue;
        }
        if (identity?.groupSerial !== request.groupSerial) {
          addReason(
            reasons,
            `tile-ready event ${index} changed group serial for ${request.id}`,
          );
        }
        if (request.groupSerial !== null) {
          groupSerials.add(request.groupSerial);
        }
        seen.add(request.id);
        request.ready = true;
        request.readyFrameNumber = Number.isFinite(event.frameNumber)
          ? event.frameNumber
          : null;
        request.lifecycle.push("tile-ready");
        stableRequests.push(request.id);
      }
      if (contentKind === "multiple" && groupSerials.size !== 1) {
        addReason(
          reasons,
          `tile-ready event ${index} combines multiple request groups`,
        );
      }
      stableRequests.sort();
      const groupSerial =
        contentKind === "multiple" && groupSerials.size === 1
          ? [...groupSerials][0]
          : null;
      if (
        contentKind === "multiple" &&
        groupSerial !== latestIssuedMultipleGroupByTile.get(tile)
      ) {
        addReason(
          reasons,
          `tile-ready event ${index} references a stale request group`,
        );
      }
      const expectedRequests = [...requestsByLocalId.values()]
        .filter(
          (request) =>
            request.tile === tile &&
            (contentKind === "multiple"
              ? request.groupSerial === groupSerial
              : request.contentKind === "single"),
        )
        .filter((request) => {
          if (contentKind === "multiple") {
            return true;
          }
          return ![...requestsByLocalId.values()].some(
            (candidate) =>
              candidate.tile === request.tile &&
              candidate.contentSlot === request.contentSlot &&
              candidate.requestSerial > request.requestSerial,
          );
        })
        .map((request) => request.id)
        .sort();
      if (!compareStableValues(stableRequests, expectedRequests)) {
        addReason(
          reasons,
          `tile-ready event ${index} does not contain the exact current request group`,
        );
      }
      for (const requestId of stableRequests) {
        const request = requestsByStableIdDuringEvents.get(requestId);
        const outcome = request
          ? contentOutcomesByRequestId.get(request.localRequestId)
          : null;
        if (!outcome) {
          addReason(
            reasons,
            `tile-ready event ${index} occurred before the content outcome for ${requestId}`,
          );
          continue;
        }
        if (outcome.type === "content-discarded") {
          addReason(
            reasons,
            `tile-ready event ${index} references discarded content for ${requestId}`,
          );
        }
        for (const modelPath of outcome.modelPaths) {
          const model = modelsById.get(
            stableModelId(
              request.tile,
              request.contentSlot,
              request.requestSerial,
              modelPath,
            ),
          );
          if (!model?.contentReady) {
            addReason(
              reasons,
              `tile-ready event ${index} occurred before model ${modelPath} became content-ready`,
            );
          }
        }
      }
      const tileReadyKey = JSON.stringify([tile, groupSerial, stableRequests]);
      if (tileReadyKeys.has(tileReadyKey)) {
        addReason(
          reasons,
          `tile-ready event ${index} repeats a ready generation`,
        );
      }
      tileReadyKeys.add(tileReadyKey);
      tileReadyEvents.push({
        tile,
        groupSerial,
        requests: stableRequests,
      });
      continue;
    }

    addReason(reasons, `request event ${index} has unknown type ${event.type}`);
  }

  for (const [tileSlotKey, serials] of serialsByTileSlot) {
    const sorted = [...serials].sort((left, right) => left - right);
    for (let index = 0; index < sorted.length; index++) {
      if (sorted[index] !== index + 1) {
        addReason(
          reasons,
          `request serials are not contiguous for ${tileSlotKey}`,
        );
        break;
      }
    }
  }
  for (const [tileSlotKey, attempts] of attemptsByTileSlot) {
    const sorted = [...attempts].sort((left, right) => left - right);
    for (let index = 0; index < sorted.length; index++) {
      if (sorted[index] !== index + 1) {
        addReason(
          reasons,
          `attempt serials are not contiguous for ${tileSlotKey}`,
        );
        break;
      }
    }
  }
  const groupSerialsByTile = new Map();
  for (const [key, group] of multipleGroups) {
    const observedSlots = [...group.contentSlots].sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );
    const boundedGroupSize = group.groupSize <= events.length;
    const hasCanonicalSlots =
      boundedGroupSize &&
      group.contentSlots.size === group.groupSize &&
      observedSlots.every((slot) => {
        const match = /^content-(0|[1-9]\d*)$/.exec(slot);
        if (!match) {
          return false;
        }
        const slotIndex = Number(match[1]);
        return Number.isSafeInteger(slotIndex) && slotIndex < group.groupSize;
      });
    if (!hasCanonicalSlots) {
      const expectedSlots = boundedGroupSize
        ? `content-0..content-${group.groupSize - 1}`
        : `bounded group size <= ${events.length}`;
      addReason(
        reasons,
        `multiple-content request group ${key} has noncanonical or incomplete slots (${observedSlots.join(",") || "none"}/${expectedSlots})`,
      );
    }
    const serials = groupSerialsByTile.get(group.tile) ?? new Set();
    serials.add(group.groupSerial);
    groupSerialsByTile.set(group.tile, serials);
  }
  for (const [tile, serials] of groupSerialsByTile) {
    const sorted = [...serials].sort((left, right) => left - right);
    for (let index = 0; index < sorted.length; index++) {
      if (sorted[index] !== index + 1) {
        addReason(
          reasons,
          `multiple-content group serials are not contiguous for ${tile}`,
        );
        break;
      }
    }
  }

  const requests = [...requestsByStableKey.values()].sort(
    (left, right) =>
      left.tile.localeCompare(right.tile) ||
      left.contentSlot.localeCompare(right.contentSlot) ||
      left.requestSerial - right.requestSerial,
  );
  const requestsByStableId = new Map(
    requests.map((request) => [request.id, request]),
  );
  const latestSerialByTileSlot = new Map();
  for (const request of requests) {
    const key = JSON.stringify([request.tile, request.contentSlot]);
    latestSerialByTileSlot.set(
      key,
      Math.max(latestSerialByTileSlot.get(key) ?? 0, request.requestSerial),
    );
  }
  if (requests.length === 0) {
    addReason(reasons, "request lifecycle event stream has no issued requests");
  }
  for (const request of requests) {
    if (
      request.terminalType === "cancelled-settled" &&
      request.cancelled !== true
    ) {
      addReason(
        reasons,
        `request ${request.id} settled as cancelled without a cancellation event`,
      );
    }
    if (
      request.terminalType !== null &&
      (request.contentKind === "multiple" ||
        request.terminalType === "completed") &&
      !contentOutcomesByRequestId.has(request.localRequestId)
    ) {
      addReason(reasons, `request ${request.id} has no content outcome`);
    }
  }

  const expectedModelIds = new Set();
  for (const [localRequestId, outcome] of contentOutcomesByRequestId) {
    const request = requestsByLocalId.get(localRequestId);
    for (const modelPath of outcome.modelPaths) {
      expectedModelIds.add(
        stableModelId(
          request.tile,
          request.contentSlot,
          request.requestSerial,
          modelPath,
        ),
      );
    }
  }
  for (const id of expectedModelIds) {
    const model = modelsById.get(id);
    if (!model) {
      addReason(reasons, `model ${id} has no readiness transition`);
      continue;
    }
    if (model.contentReady && !model.modelReady) {
      addReason(reasons, `model ${id} content became ready before the model`);
    }
    if (model.modelReady && !model.contentReady) {
      addReason(reasons, `model ${id} has no content-ready transition`);
    }
    if (
      model.destroyedBeforeReady &&
      (model.modelReady || model.contentReady)
    ) {
      addReason(
        reasons,
        `model ${id} was both ready and destroyed-before-ready`,
      );
    }
  }
  for (const id of modelsById.keys()) {
    if (!expectedModelIds.has(id)) {
      addReason(reasons, `model ${id} was not declared by its content outcome`);
    }
  }

  for (const tileReady of tileReadyEvents) {
    for (const requestId of tileReady.requests) {
      const stableRequest = requestsByStableId.get(requestId);
      const outcome = stableRequest
        ? contentOutcomesByRequestId.get(stableRequest.localRequestId)
        : null;
      if (!outcome) {
        addReason(
          reasons,
          `tile-ready event for ${tileReady.tile} has no content outcome for ${requestId}`,
        );
        continue;
      }
      for (const modelPath of outcome.modelPaths) {
        const model = modelsById.get(
          stableModelId(
            stableRequest.tile,
            stableRequest.contentSlot,
            stableRequest.requestSerial,
            modelPath,
          ),
        );
        if (!model?.contentReady) {
          addReason(
            reasons,
            `tile ${tileReady.tile} became ready before model ${modelPath}`,
          );
        }
      }
    }
  }
  const tileReadyRequestIds = new Set(
    tileReadyEvents.flatMap((event) => event.requests),
  );
  for (const request of requests) {
    const latestSerial = latestSerialByTileSlot.get(
      JSON.stringify([request.tile, request.contentSlot]),
    );
    if (request.requestSerial !== latestSerial) {
      continue;
    }
    const outcome = contentOutcomesByRequestId.get(request.localRequestId);
    if (
      outcome?.type !== "content-created" ||
      outcome.modelPaths.length === 0
    ) {
      continue;
    }
    const modelStates = outcome.modelPaths.map((modelPath) =>
      modelsById.get(
        stableModelId(
          request.tile,
          request.contentSlot,
          request.requestSerial,
          modelPath,
        ),
      ),
    );
    if (
      modelStates.every((model) => model?.contentReady === true) &&
      !tileReadyRequestIds.has(request.id)
    ) {
      addReason(reasons, `request ${request.id} has no tile-ready transition`);
    }
  }

  const eventCount = (type) =>
    events.filter((event) => event?.type === type).length;
  const derivedTotals = {
    requestAttempts:
      eventCount("issued") + eventCount("reissued") + deferralCount,
    requestsIssued: eventCount("issued") + eventCount("reissued"),
    requestSchedulingDeferrals: deferralCount,
    requestsCancelled: eventCount("cancelled"),
    requestsReissued: eventCount("reissued"),
    requestsReissuedAfterCancellation: requests.filter((request) => {
      if (request.requestSerial <= 1) {
        return false;
      }
      return (
        requestsByStableKey.get(
          stableRequestMapKey(
            request.tile,
            request.contentSlot,
            request.requestSerial - 1,
          ),
        )?.terminalType === "cancelled-settled"
      );
    }).length,
    requestsCompleted: eventCount("completed"),
    requestsFailed: eventCount("failed"),
    requestsResolvedWithoutContent:
      eventCount("cancelled-settled") + eventCount("resolved-without-content"),
    tileReadyEvents: eventCount("tile-ready"),
    contentCreatedEvents: eventCount("content-created"),
    contentFactoryFailures: eventCount("content-factory-failed"),
    requestCancellationNoops: eventCount("cancel-requested-noop"),
    modelReadyEvents: eventCount("model-ready"),
    contentReadyEvents: eventCount("content-ready"),
    modelDestroyedBeforeReadyEvents: eventCount("model-destroyed-before-ready"),
  };
  for (const [name, expected] of Object.entries(derivedTotals)) {
    const actual = diagnostics?.totals?.[name];
    if (!Number.isInteger(actual) || actual < 0) {
      addReason(
        reasons,
        `request lifecycle total ${name} is missing or invalid`,
      );
    } else if (actual !== expected) {
      addReason(
        reasons,
        `request lifecycle total ${name} disagrees with events (${actual}/${expected})`,
      );
    }
  }
  const expectedMultipleAttempts = events
    .filter((event) => event?.contentKind === "multiple")
    .filter(
      (event) =>
        event.type === "issued" ||
        event.type === "reissued" ||
        event.type === "scheduling-deferred",
    ).length;
  if (
    diagnostics?.totals?.multipleContentRequestAttempts !==
    expectedMultipleAttempts
  ) {
    addReason(
      reasons,
      "multiple-content request-attempt total disagrees with events",
    );
  }
  for (const name of BYTE_TOTAL_NAMES) {
    const value = diagnostics?.totals?.[name];
    if (!Number.isFinite(value) || value < 0) {
      addReason(
        reasons,
        `request lifecycle byte total ${name} is missing or invalid`,
      );
    }
  }

  const contentOutcomes = [...contentOutcomesByRequestId.values()].sort(
    (left, right) => left.requestId.localeCompare(right.requestId),
  );
  const models = [...modelsById.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  tileReadyEvents.sort(
    (left, right) =>
      left.tile.localeCompare(right.tile) ||
      JSON.stringify(left.requests).localeCompare(
        JSON.stringify(right.requests),
      ),
  );
  const tileChronologies = [...chronologies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, chronology]) => {
      const [tile, contentSlot] = JSON.parse(key);
      return { tile, contentSlot, chronology: [...chronology] };
    });
  const signatureValues = [
    ...requests.map((request) =>
      JSON.stringify([
        request.tile,
        request.contentSlot,
        request.requestSerial,
        request.attemptSerial,
        request.groupSerial,
        request.groupSize,
        request.url,
        request.lifecycle,
      ]),
    ),
    ...contentOutcomes.map((outcome) => JSON.stringify(outcome)),
    ...models.map((model) => JSON.stringify(model)),
    ...tileReadyEvents.map((entry) => JSON.stringify(entry)),
    ...tileChronologies.map((entry) => JSON.stringify(entry)),
  ];
  const byteTotals = Object.fromEntries(
    BYTE_TOTAL_NAMES.map((name) => [
      name,
      Number.isFinite(diagnostics?.totals?.[name]) &&
      diagnostics.totals[name] >= 0
        ? diagnostics.totals[name]
        : null,
    ]),
  );

  return {
    schemaVersion: 2,
    valid: reasons.length === 0,
    complete: reasons.length === 0,
    reasons,
    eventCount: events.length,
    requestCount: requests.length,
    deferralCount,
    openRequestCount: requests.filter(
      (request) => request.terminalType === null,
    ).length,
    signature: reasons.length === 0 ? signatureFor(signatureValues) : null,
    coverage: {
      singleContentObserved,
      multipleContentObserved,
      multipleContentSupported: true,
      modelReadinessObserved: models.length > 0,
    },
    requests,
    tileChronologies,
    readiness: {
      contentOutcomes,
      models,
      tiles: tileReadyEvents,
      factoryFailureCount: eventCount("content-factory-failed"),
      destroyedBeforeReadyCount: eventCount("model-destroyed-before-ready"),
    },
    latencyFrames: {
      settle: summarizeFinite(
        requests.map((request) =>
          Number.isFinite(request.issueFrameNumber) &&
          Number.isFinite(request.terminalFrameNumber)
            ? request.terminalFrameNumber - request.issueFrameNumber
            : null,
        ),
      ),
      ready: summarizeFinite(
        requests.map((request) =>
          Number.isFinite(request.issueFrameNumber) &&
          Number.isFinite(request.readyFrameNumber)
            ? request.readyFrameNumber - request.issueFrameNumber
            : null,
        ),
      ),
    },
    byteTotals,
  };
}

/**
 * Normalize one renderer leg without silently upgrading legacy evidence.
 * Schema 1 remains the original single-content contract. Schema 2 is opt-in
 * and adds actual multiple-content slots plus model/content/tile readiness.
 */
export function createRepresentativeTilesetRequestLedger(diagnostics) {
  const schemaVersion = diagnostics?.schemaVersion ?? 1;
  if (schemaVersion === 1) {
    return createRepresentativeTilesetRequestLedgerV1(diagnostics);
  }
  if (schemaVersion === 2) {
    return createRepresentativeTilesetRequestLedgerV2(diagnostics);
  }
  return emptyRequestLedger(
    schemaVersion,
    `unsupported request lifecycle schema ${schemaVersion}`,
  );
}

/**
 * Compare two structurally valid ledgers. A lifecycle mismatch is attribution,
 * not malformed evidence: `valid` remains true while `match` becomes false.
 *
 * @param {object} leftDiagnostics WebGL/raw endpoint diagnostics.
 * @param {object} rightDiagnostics WebGPU/raw endpoint diagnostics.
 * @returns {object} Cross-leg request-ledger comparison.
 */
export function compareRepresentativeTilesetRequestLedgers(
  leftDiagnostics,
  rightDiagnostics,
) {
  const left = createRepresentativeTilesetRequestLedger(leftDiagnostics);
  const right = createRepresentativeTilesetRequestLedger(rightDiagnostics);
  if (!left.valid || !right.valid) {
    return {
      available:
        Array.isArray(leftDiagnostics?.events) &&
        Array.isArray(rightDiagnostics?.events),
      valid: false,
      match: null,
      reasons: [
        ...left.reasons.map((reason) => `WebGL request ledger: ${reason}`),
        ...right.reasons.map((reason) => `WebGPU request ledger: ${reason}`),
      ],
      webgl: summarizeEndpoint(left),
      webgpu: summarizeEndpoint(right),
      requestIdentityMatch: null,
      chronologyMatch: null,
      mismatches: [],
      mismatchesTruncated: false,
      firstMismatch: null,
      byteOutcomes: null,
      latencyOutcomes: null,
    };
  }
  if (left.schemaVersion !== right.schemaVersion) {
    return {
      available: true,
      valid: false,
      match: null,
      reasons: [
        `request ledger schema mismatch (${left.schemaVersion}/${right.schemaVersion})`,
      ],
      webgl: summarizeEndpoint(left),
      webgpu: summarizeEndpoint(right),
      requestIdentityMatch: null,
      chronologyMatch: null,
      mismatches: [],
      mismatchesTruncated: false,
      firstMismatch: null,
      byteOutcomes: null,
      latencyOutcomes: null,
    };
  }

  const leftRequests = new Map(
    left.requests.map((request) => [request.id, request]),
  );
  const rightRequests = new Map(
    right.requests.map((request) => [request.id, request]),
  );
  const requestIds = [
    ...new Set([...leftRequests.keys(), ...rightRequests.keys()]),
  ].sort();
  const mismatches = [];
  let mismatchCount = 0;
  const recordMismatch = (mismatch) => {
    mismatchCount++;
    if (mismatches.length < COMPARISON_MISMATCH_LIMIT) {
      mismatches.push(mismatch);
    }
  };
  for (const id of requestIds) {
    const webgl = leftRequests.get(id);
    const webgpu = rightRequests.get(id);
    if (!webgl || !webgpu) {
      recordMismatch({
        id,
        kind: "missing-request",
        webgl: webgl ? { ...webgl } : null,
        webgpu: webgpu ? { ...webgpu } : null,
      });
      continue;
    }
    const differingFields = [];
    for (const field of [
      "attemptSerial",
      "url",
      "issueType",
      "terminalType",
      "cancelled",
      "ready",
      "lifecycle",
    ]) {
      if (!compareStableValues(webgl[field], webgpu[field])) {
        differingFields.push(field);
      }
    }
    if (differingFields.length > 0) {
      recordMismatch({
        id,
        kind: "request-lifecycle",
        differingFields,
        webgl: Object.fromEntries(
          differingFields.map((field) => [field, webgl[field]]),
        ),
        webgpu: Object.fromEntries(
          differingFields.map((field) => [field, webgpu[field]]),
        ),
      });
    }
  }

  const chronologyKey = (entry) =>
    entry.contentSlot === undefined
      ? entry.tile
      : JSON.stringify([entry.tile, entry.contentSlot]);
  const leftChronologies = new Map(
    left.tileChronologies.map((entry) => [
      chronologyKey(entry),
      entry.chronology,
    ]),
  );
  const rightChronologies = new Map(
    right.tileChronologies.map((entry) => [
      chronologyKey(entry),
      entry.chronology,
    ]),
  );
  let chronologyMatch = true;
  for (const tile of [
    ...new Set([...leftChronologies.keys(), ...rightChronologies.keys()]),
  ].sort()) {
    const webgl = leftChronologies.get(tile) ?? null;
    const webgpu = rightChronologies.get(tile) ?? null;
    if (!compareStableValues(webgl, webgpu)) {
      chronologyMatch = false;
      recordMismatch({
        id: tile,
        kind: "tile-chronology",
        webgl,
        webgpu,
      });
    }
  }

  if (
    left.schemaVersion === 2 &&
    !compareStableValues(left.readiness, right.readiness)
  ) {
    chronologyMatch = false;
    recordMismatch({
      id: "readiness",
      kind: "readiness-lifecycle",
      webgl: left.readiness,
      webgpu: right.readiness,
    });
  }

  const requestIdentityMatch = requestIds.every(
    (id) => leftRequests.has(id) && rightRequests.has(id),
  );
  const byteOutcomes = Object.fromEntries(
    BYTE_TOTAL_NAMES.map((name) => [
      name,
      {
        webgl: left.byteTotals[name],
        webgpu: right.byteTotals[name],
        match: left.byteTotals[name] === right.byteTotals[name],
        certifying: false,
      },
    ]),
  );

  return {
    available: true,
    valid: true,
    match: mismatchCount === 0,
    reasons: [],
    webgl: summarizeEndpoint(left),
    webgpu: summarizeEndpoint(right),
    requestIdentityMatch,
    chronologyMatch,
    mismatchCount,
    mismatches,
    mismatchesTruncated: mismatchCount > mismatches.length,
    firstMismatch: mismatches[0] ?? null,
    byteOutcomes,
    latencyOutcomes: {
      webgl: left.latencyFrames,
      webgpu: right.latencyFrames,
      certifying: false,
    },
  };
}
