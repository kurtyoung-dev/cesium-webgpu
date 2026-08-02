import assert from "node:assert/strict";
import test from "node:test";

import {
  compareRepresentativeTilesetRequestLedgers,
  createRepresentativeTilesetRequestLedger,
} from "./lib/representative-tileset-request-ledger.mjs";

function makeDiagnostics(events, overrides = {}) {
  const { totals: totalOverrides = {}, ...diagnosticOverrides } = overrides;
  const sequencedEvents = events.map((event, sequence) => ({
    sequence,
    ...event,
  }));
  const count = (type) =>
    sequencedEvents.filter((event) => event.type === type).length;
  const reissuedAfterCancellation = sequencedEvents.filter((event) => {
    if (event.type !== "reissued") {
      return false;
    }
    return sequencedEvents.some(
      (candidate) =>
        candidate.type === "cancelled-settled" &&
        candidate.tile === event.tile &&
        candidate.requestSerial === event.requestSerial - 1,
    );
  }).length;
  return {
    schemaVersion: 1,
    enabled: true,
    nonCertifying: true,
    eventsTruncated: false,
    totals: {
      requestAttempts:
        count("issued") + count("reissued") + count("scheduling-deferred"),
      requestsIssued: count("issued") + count("reissued"),
      requestSchedulingDeferrals: count("scheduling-deferred"),
      requestsCancelled: count("cancelled"),
      requestsReissued: count("reissued"),
      requestsReissuedAfterCancellation: reissuedAfterCancellation,
      requestsCompleted: count("completed"),
      requestsFailed: count("failed"),
      requestsResolvedWithoutContent:
        count("cancelled-settled") + count("resolved-without-content"),
      tileReadyEvents: count("ready"),
      multipleContentRequestAttempts: sequencedEvents.filter(
        (event) =>
          event.contentKind === "multiple" &&
          (event.type === "issued" ||
            event.type === "reissued" ||
            event.type === "scheduling-deferred"),
      ).length,
      transferBytes: 120,
      encodedBodyBytes: 100,
      decodedBodyBytes: 100,
      ...totalOverrides,
    },
    events: sequencedEvents,
    ...diagnosticOverrides,
  };
}

function issue(
  requestId,
  tile,
  requestSerial,
  attemptSerial,
  frameNumber,
  url = `http://localhost/${tile}.b3dm`,
) {
  return {
    type: requestSerial === 1 ? "issued" : "reissued",
    requestId,
    tile,
    contentKind: "single",
    contentSlot: "single",
    requestSerial,
    attemptSerial,
    frameNumber,
    url,
    requestObjectObserved: true,
  };
}

function transition(type, requestId, tile, requestSerial, frameNumber) {
  return {
    type,
    requestId,
    tile,
    contentKind: "single",
    contentSlot: "single",
    requestSerial,
    frameNumber,
  };
}

function makeV2Diagnostics(events, overrides = {}) {
  const { totals: totalOverrides = {}, ...diagnosticOverrides } = overrides;
  const sequencedEvents = events.map((event, sequence) => ({
    sequence,
    ...event,
  }));
  const count = (type) =>
    sequencedEvents.filter((event) => event.type === type).length;
  const requestEvents = sequencedEvents.filter((event) =>
    ["issued", "reissued", "scheduling-deferred"].includes(event.type),
  );
  const terminalByStableId = new Map();
  for (const event of sequencedEvents) {
    if (
      [
        "completed",
        "failed",
        "cancelled-settled",
        "resolved-without-content",
      ].includes(event.type)
    ) {
      terminalByStableId.set(
        `${event.tile}/${event.contentSlot}/${event.requestSerial}`,
        event.type,
      );
    }
  }
  const reissuedAfterCancellation = sequencedEvents.filter(
    (event) =>
      event.type === "reissued" &&
      terminalByStableId.get(
        `${event.tile}/${event.contentSlot}/${event.requestSerial - 1}`,
      ) === "cancelled-settled",
  ).length;
  return {
    schemaVersion: 2,
    enabled: true,
    nonCertifying: true,
    eventsTruncated: false,
    totals: {
      requestAttempts: requestEvents.length,
      requestsIssued: count("issued") + count("reissued"),
      requestSchedulingDeferrals: count("scheduling-deferred"),
      requestsCancelled: count("cancelled"),
      requestsReissued: count("reissued"),
      requestsReissuedAfterCancellation: reissuedAfterCancellation,
      requestsCompleted: count("completed"),
      requestsFailed: count("failed"),
      requestsResolvedWithoutContent:
        count("cancelled-settled") + count("resolved-without-content"),
      multipleContentRequestAttempts: requestEvents.filter(
        (event) => event.contentKind === "multiple",
      ).length,
      tileReadyEvents: count("tile-ready"),
      contentCreatedEvents: count("content-created"),
      contentFactoryFailures: count("content-factory-failed"),
      requestCancellationNoops: count("cancel-requested-noop"),
      modelReadyEvents: count("model-ready"),
      contentReadyEvents: count("content-ready"),
      modelDestroyedBeforeReadyEvents: count("model-destroyed-before-ready"),
      transferBytes: 120,
      encodedBodyBytes: 100,
      decodedBodyBytes: 100,
      ...totalOverrides,
    },
    events: sequencedEvents,
    ...diagnosticOverrides,
  };
}

function v2Issue(
  requestId,
  contentSlot,
  requestSerial = 1,
  attemptSerial = requestSerial,
  groupSerial = 1,
  groupSize = 2,
) {
  const tile = "tileset-0/root";
  return {
    type: requestSerial === 1 ? "issued" : "reissued",
    requestId,
    tile,
    contentKind: "multiple",
    contentSlot,
    requestSerial,
    attemptSerial,
    groupSerial,
    groupSize,
    url: `http://localhost/${contentSlot}.b3dm`,
    requestObjectObserved: true,
  };
}

function v2Transition(type, issueEvent, overrides = {}) {
  return {
    type,
    requestId: issueEvent.requestId,
    tile: issueEvent.tile,
    contentKind: issueEvent.contentKind,
    contentSlot: issueEvent.contentSlot,
    requestSerial: issueEvent.requestSerial,
    attemptSerial: issueEvent.attemptSerial,
    groupSerial: issueEvent.groupSerial,
    groupSize: issueEvent.groupSize,
    ...overrides,
  };
}

function v2ModelEvent(type, issueEvent, modelPath = "model") {
  return v2Transition(type, issueEvent, {
    modelPath,
    modelId: `${issueEvent.tile}::${issueEvent.contentSlot}::${issueEvent.requestSerial}::${modelPath}`,
  });
}

test("stable request identity ignores local IDs, global interleaving, frame origin, and byte outcomes", () => {
  const webgl = makeDiagnostics([
    issue(1, "tileset-0/root/0", 1, 1, 10),
    issue(2, "tileset-0/root/1", 1, 1, 10),
    transition("completed", 1, "tileset-0/root/0", 1, 12),
    transition("completed", 2, "tileset-0/root/1", 1, 13),
    transition("ready", 1, "tileset-0/root/0", 1, 15),
    transition("ready", 2, "tileset-0/root/1", 1, 16),
  ]);
  const webgpu = makeDiagnostics(
    [
      issue(91, "tileset-0/root/1", 1, 1, 110),
      issue(44, "tileset-0/root/0", 1, 1, 111),
      transition("completed", 91, "tileset-0/root/1", 1, 112),
      transition("ready", 91, "tileset-0/root/1", 1, 114),
      transition("completed", 44, "tileset-0/root/0", 1, 116),
      transition("ready", 44, "tileset-0/root/0", 1, 119),
    ],
    {
      totals: {
        transferBytes: 0,
        encodedBodyBytes: 100,
        decodedBodyBytes: 100,
      },
    },
  );

  const comparison = compareRepresentativeTilesetRequestLedgers(webgl, webgpu);
  assert.equal(comparison.valid, true);
  assert.equal(comparison.match, true);
  assert.equal(comparison.requestIdentityMatch, true);
  assert.equal(comparison.chronologyMatch, true);
  assert.equal(comparison.byteOutcomes.transferBytes.match, false);
  assert.equal(comparison.byteOutcomes.transferBytes.certifying, false);
  assert.notDeepEqual(
    comparison.latencyOutcomes.webgl,
    comparison.latencyOutcomes.webgpu,
  );
  assert.equal(comparison.latencyOutcomes.certifying, false);
});

test("cancel, scheduling deferral, and reissue form one stable per-tile chronology", () => {
  const diagnostics = makeDiagnostics([
    issue(1, "tileset-0/root/0", 1, 1, 10),
    transition("cancelled", 1, "tileset-0/root/0", 1, 11),
    transition("cancelled-settled", 1, "tileset-0/root/0", 1, 12),
    {
      type: "scheduling-deferred",
      requestId: null,
      tile: "tileset-0/root/0",
      contentKind: "single",
      contentSlot: "single",
      requestSerial: null,
      attemptSerial: 2,
      frameNumber: 13,
    },
    issue(2, "tileset-0/root/0", 2, 3, 14),
    transition("completed", 2, "tileset-0/root/0", 2, 15),
    transition("ready", 2, "tileset-0/root/0", 2, 17),
  ]);

  const ledger = createRepresentativeTilesetRequestLedger(diagnostics);
  assert.equal(ledger.valid, true);
  assert.equal(ledger.requestCount, 2);
  assert.equal(ledger.deferralCount, 1);
  assert.equal(ledger.openRequestCount, 0);
  assert.equal(ledger.requests[0].cancelled, true);
  assert.equal(ledger.requests[0].terminalType, "cancelled-settled");
  assert.equal(ledger.requests[1].attemptSerial, 3);
  assert.deepEqual(ledger.tileChronologies[0].chronology, [
    "request:1:issued",
    "request:1:cancelled",
    "request:1:cancelled-settled",
    "attempt:2:scheduling-deferred",
    "request:2:reissued",
    "request:2:completed",
    "request:2:ready",
  ]);
});

test("late cancellation preserves accepted content as a completed request", () => {
  const diagnostics = makeDiagnostics([
    issue(1, "tileset-0/root/0", 1, 1, 10),
    transition("cancelled", 1, "tileset-0/root/0", 1, 11),
    transition("completed", 1, "tileset-0/root/0", 1, 12),
    transition("ready", 1, "tileset-0/root/0", 1, 13),
    issue(2, "tileset-0/root/0", 2, 2, 20),
    transition("completed", 2, "tileset-0/root/0", 2, 21),
  ]);

  const ledger = createRepresentativeTilesetRequestLedger(diagnostics);
  assert.equal(ledger.valid, true);
  assert.equal(diagnostics.totals.requestsReissuedAfterCancellation, 0);
  assert.equal(ledger.requests[0].terminalType, "completed");
  assert.deepEqual(ledger.requests[0].lifecycle, [
    "issued",
    "cancelled",
    "completed",
    "ready",
  ]);
});

test("request ledger comparisons attribute URL, lifecycle, and reissue mutations", async (t) => {
  const baselineEvents = [
    issue(1, "tileset-0/root/0", 1, 1, 10),
    transition("completed", 1, "tileset-0/root/0", 1, 12),
    transition("ready", 1, "tileset-0/root/0", 1, 15),
  ];

  await t.test("URL mutation", () => {
    const mutated = structuredClone(baselineEvents);
    mutated[0].url = "http://localhost/replacement.b3dm";
    const comparison = compareRepresentativeTilesetRequestLedgers(
      makeDiagnostics(baselineEvents),
      makeDiagnostics(mutated),
    );
    assert.equal(comparison.valid, true);
    assert.equal(comparison.match, false);
    assert.ok(comparison.firstMismatch.differingFields.includes("url"));
  });

  await t.test("terminal mutation", () => {
    const mutated = structuredClone(baselineEvents);
    mutated[1].type = "failed";
    mutated.splice(2, 1);
    const comparison = compareRepresentativeTilesetRequestLedgers(
      makeDiagnostics(baselineEvents),
      makeDiagnostics(mutated),
    );
    assert.equal(comparison.valid, true);
    assert.equal(comparison.match, false);
    assert.ok(
      comparison.mismatches.some(
        (mismatch) =>
          mismatch.kind === "request-lifecycle" &&
          mismatch.differingFields.includes("terminalType"),
      ),
    );
  });

  await t.test("extra cancellation", () => {
    const mutated = structuredClone(baselineEvents);
    mutated.splice(1, 0, transition("cancelled", 1, "tileset-0/root/0", 1, 11));
    const comparison = compareRepresentativeTilesetRequestLedgers(
      makeDiagnostics(baselineEvents),
      makeDiagnostics(mutated),
    );
    assert.equal(comparison.valid, true);
    assert.equal(comparison.match, false);
    assert.equal(comparison.chronologyMatch, false);
  });

  await t.test("extra reissue", () => {
    const mutated = [
      ...structuredClone(baselineEvents),
      issue(2, "tileset-0/root/0", 2, 2, 16),
      transition("completed", 2, "tileset-0/root/0", 2, 17),
    ];
    const comparison = compareRepresentativeTilesetRequestLedgers(
      makeDiagnostics(baselineEvents),
      makeDiagnostics(mutated),
    );
    assert.equal(comparison.valid, true);
    assert.equal(comparison.match, false);
    assert.equal(comparison.requestIdentityMatch, false);
    assert.equal(comparison.firstMismatch.kind, "missing-request");
  });
});

test("request ledger fails closed on malformed or incomplete lifecycle evidence", async (t) => {
  await t.test("vacuous event stream", () => {
    const ledger = createRepresentativeTilesetRequestLedger(
      makeDiagnostics([]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) => reason.includes("no issued requests")),
    );
  });

  await t.test("truncation", () => {
    const ledger = createRepresentativeTilesetRequestLedger(
      makeDiagnostics([issue(1, "tileset-0/root/0", 1, 1, 10)], {
        eventsTruncated: true,
      }),
    );
    assert.equal(ledger.valid, false);
    assert.ok(ledger.reasons.some((reason) => reason.includes("truncated")));
  });

  await t.test("serial gap", () => {
    const ledger = createRepresentativeTilesetRequestLedger(
      makeDiagnostics([
        issue(1, "tileset-0/root/0", 1, 1, 10),
        issue(2, "tileset-0/root/0", 3, 2, 11),
      ]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) => reason.includes("not contiguous")),
    );
  });

  await t.test("orphan transition", () => {
    const ledger = createRepresentativeTilesetRequestLedger(
      makeDiagnostics([transition("completed", 99, "tileset-0/root/0", 1, 12)]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) => reason.includes("no matching issued")),
    );
  });

  await t.test("ready after failure", () => {
    const ledger = createRepresentativeTilesetRequestLedger(
      makeDiagnostics([
        issue(1, "tileset-0/root/0", 1, 1, 10),
        transition("failed", 1, "tileset-0/root/0", 1, 12),
        transition("ready", 1, "tileset-0/root/0", 1, 13),
      ]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("became ready without a completed terminal event"),
      ),
    );
  });

  await t.test("transition identity drift", () => {
    const completed = transition("completed", 1, "tileset-0/root/0", 1, 12);
    completed.attemptSerial = 2;
    completed.contentSlot = "replacement";
    const ledger = createRepresentativeTilesetRequestLedger(
      makeDiagnostics([issue(1, "tileset-0/root/0", 1, 1, 10), completed]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) => reason.includes("changed content slot")),
    );
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("changed attempt serial"),
      ),
    );
  });

  await t.test("late cancellation", () => {
    const ledger = createRepresentativeTilesetRequestLedger(
      makeDiagnostics([
        issue(1, "tileset-0/root/0", 1, 1, 10),
        transition("completed", 1, "tileset-0/root/0", 1, 12),
        transition("cancelled", 1, "tileset-0/root/0", 1, 13),
      ]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("was cancelled after it settled"),
      ),
    );
  });

  await t.test("cancelled settlement before cancellation", () => {
    const ledger = createRepresentativeTilesetRequestLedger(
      makeDiagnostics([
        issue(1, "tileset-0/root/0", 1, 1, 10),
        transition("cancelled-settled", 1, "tileset-0/root/0", 1, 12),
        transition("cancelled", 1, "tileset-0/root/0", 1, 13),
      ]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("before its cancellation event"),
      ),
    );
  });

  await t.test("missing issued URL", () => {
    const issued = issue(1, "tileset-0/root/0", 1, 1, 10);
    issued.url = "";
    const ledger = createRepresentativeTilesetRequestLedger(
      makeDiagnostics([issued]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) => reason.includes("no request URL")),
    );
  });

  await t.test("missing or negative byte totals", () => {
    const diagnostics = makeDiagnostics([
      issue(1, "tileset-0/root/0", 1, 1, 10),
    ]);
    delete diagnostics.totals.transferBytes;
    diagnostics.totals.decodedBodyBytes = -1;
    const ledger = createRepresentativeTilesetRequestLedger(diagnostics);
    assert.equal(ledger.valid, false);
    assert.equal(ledger.byteTotals.transferBytes, null);
    assert.equal(ledger.byteTotals.decodedBodyBytes, null);
    assert.ok(
      ledger.reasons.some((reason) => reason.includes("transferBytes")),
    );
    assert.ok(
      ledger.reasons.some((reason) => reason.includes("decodedBodyBytes")),
    );
  });
});

test("pending single-content requests are representable without fabricating completion", () => {
  const ledger = createRepresentativeTilesetRequestLedger(
    makeDiagnostics([issue(1, "tileset-0/root/0", 1, 1, 10)]),
  );
  assert.equal(ledger.valid, true);
  assert.equal(ledger.complete, true);
  assert.equal(ledger.openRequestCount, 1);
  assert.equal(ledger.requests[0].terminalType, null);
});

test("multiple-content observations fail closed instead of pretending inner-request coverage", () => {
  const multipleIssue = issue(1, "tileset-0/root/0", 1, 1, 10);
  multipleIssue.contentKind = "multiple";
  multipleIssue.requestObjectObserved = false;
  const ledger = createRepresentativeTilesetRequestLedger(
    makeDiagnostics([multipleIssue]),
  );
  assert.equal(ledger.valid, false);
  assert.equal(ledger.coverage.multipleContentObserved, true);
  assert.equal(ledger.coverage.multipleContentSupported, false);
  assert.ok(
    ledger.reasons.some((reason) =>
      reason.includes("multiple-content request coverage is unsupported"),
    ),
  );
});

test("schema 2 normalizes actual multiple-content requests and model readiness", () => {
  const first = v2Issue(31, "content-0");
  const second = v2Issue(47, "content-1");
  const diagnostics = makeV2Diagnostics([
    first,
    second,
    v2Transition("completed", first),
    v2Transition("completed", second),
    v2Transition("content-created", first, {
      contentType: "Model3DTileContent",
      modelPaths: ["model"],
    }),
    v2Transition("content-created", second, {
      contentType: "Composite3DTileContent",
      modelPaths: ["composite/0/model"],
    }),
    v2ModelEvent("model-ready", first),
    v2ModelEvent("content-ready", first),
    v2ModelEvent("model-ready", second, "composite/0/model"),
    v2ModelEvent("content-ready", second, "composite/0/model"),
    {
      type: "tile-ready",
      tile: first.tile,
      contentKind: "multiple",
      contentSlot: "group",
      requests: [
        { contentSlot: "content-0", requestSerial: 1, groupSerial: 1 },
        { contentSlot: "content-1", requestSerial: 1, groupSerial: 1 },
      ],
    },
  ]);

  const ledger = createRepresentativeTilesetRequestLedger(diagnostics);
  assert.equal(ledger.schemaVersion, 2);
  assert.equal(ledger.valid, true);
  assert.equal(ledger.complete, true);
  assert.equal(ledger.requestCount, 2);
  assert.equal(ledger.coverage.multipleContentObserved, true);
  assert.equal(ledger.coverage.multipleContentSupported, true);
  assert.equal(ledger.coverage.modelReadinessObserved, true);
  assert.equal(ledger.readiness.models.length, 2);
  assert.equal(ledger.readiness.tiles.length, 1);
  assert.ok(
    ledger.requests.every(
      (request) => request.terminalType === "completed" && request.ready,
    ),
  );
});

test("schema 2 ignores cross-slot network interleaving while preserving each slot chronology", () => {
  const first = v2Issue(1, "content-0");
  const second = v2Issue(2, "content-1");
  const firstEvents = [
    v2Transition("completed", first),
    v2Transition("content-created", first, {
      contentType: "Model3DTileContent",
      modelPaths: ["model"],
    }),
    v2ModelEvent("model-ready", first),
    v2ModelEvent("content-ready", first),
  ];
  const secondEvents = [
    v2Transition("completed", second),
    v2Transition("content-created", second, {
      contentType: "Model3DTileContent",
      modelPaths: ["model"],
    }),
    v2ModelEvent("model-ready", second),
    v2ModelEvent("content-ready", second),
  ];
  const tileReady = {
    type: "tile-ready",
    tile: first.tile,
    contentKind: "multiple",
    contentSlot: "group",
    requests: [
      { contentSlot: "content-0", requestSerial: 1, groupSerial: 1 },
      { contentSlot: "content-1", requestSerial: 1, groupSerial: 1 },
    ],
  };
  const webgl = makeV2Diagnostics([
    first,
    second,
    ...firstEvents,
    ...secondEvents,
    tileReady,
  ]);
  const webgpu = makeV2Diagnostics([
    second,
    first,
    ...secondEvents,
    ...firstEvents,
    tileReady,
  ]);

  const comparison = compareRepresentativeTilesetRequestLedgers(webgl, webgpu);
  assert.equal(comparison.valid, true);
  assert.equal(comparison.match, true);
  assert.equal(comparison.chronologyMatch, true);
});

test("schema 2 keeps per-slot cancellation generations and factory failures explicit", () => {
  const oldFirst = v2Issue(1, "content-0");
  const oldSecond = v2Issue(2, "content-1");
  const newFirst = v2Issue(3, "content-0", 2, 2, 2);
  const newSecond = v2Issue(4, "content-1", 2, 2, 2);
  const diagnostics = makeV2Diagnostics([
    oldFirst,
    oldSecond,
    v2Transition("cancelled", oldFirst),
    v2Transition("cancelled", oldSecond),
    v2Transition("cancelled-settled", oldFirst),
    v2Transition("content-discarded", oldFirst),
    v2Transition("cancelled-settled", oldSecond),
    v2Transition("content-discarded", oldSecond),
    newFirst,
    newSecond,
    v2Transition("completed", newFirst),
    v2Transition("completed", newSecond),
    v2Transition("content-created", newFirst, {
      contentType: "Model3DTileContent",
      modelPaths: ["model"],
    }),
    v2Transition("content-factory-failed", newSecond),
    v2ModelEvent("model-ready", newFirst),
    v2ModelEvent("content-ready", newFirst),
    {
      type: "tile-ready",
      tile: newFirst.tile,
      contentKind: "multiple",
      contentSlot: "group",
      requests: [
        { contentSlot: "content-0", requestSerial: 2, groupSerial: 2 },
        { contentSlot: "content-1", requestSerial: 2, groupSerial: 2 },
      ],
    },
  ]);

  const ledger = createRepresentativeTilesetRequestLedger(diagnostics);
  assert.equal(ledger.valid, true);
  assert.equal(ledger.readiness.factoryFailureCount, 1);
  assert.equal(diagnostics.totals.requestsReissuedAfterCancellation, 2);
  assert.equal(
    ledger.requests.find((request) => request.requestSerial === 1).terminalType,
    "cancelled-settled",
  );
});

test("schema 2 accepts destroy-before-ready as an explicit terminal model outcome", () => {
  const issued = v2Issue(1, "content-0", 1, 1, 1, 1);
  const ledger = createRepresentativeTilesetRequestLedger(
    makeV2Diagnostics([
      issued,
      v2Transition("completed", issued),
      v2Transition("content-created", issued, {
        contentType: "Model3DTileContent",
        modelPaths: ["model"],
      }),
      v2ModelEvent("model-destroyed-before-ready", issued),
    ]),
  );
  assert.equal(ledger.valid, true);
  assert.equal(ledger.readiness.destroyedBeforeReadyCount, 1);
});

test("schema 2 validates multiple-content slots numerically beyond ten entries", async (t) => {
  const issues = Array.from({ length: 11 }, (_, index) =>
    v2Issue(index + 1, `content-${index}`, 1, 1, 1, 11),
  );
  const tileReady = {
    type: "tile-ready",
    tile: issues[0].tile,
    contentKind: "multiple",
    contentSlot: "group",
    requests: issues.map((event) => ({
      contentSlot: event.contentSlot,
      requestSerial: event.requestSerial,
      groupSerial: event.groupSerial,
    })),
  };
  const events = [
    ...issues,
    ...issues.flatMap((event) => [
      v2Transition("completed", event),
      v2Transition("content-factory-failed", event),
    ]),
    tileReady,
  ];

  await t.test("accepts the canonical content-0 through content-10 set", () => {
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(events),
    );
    assert.equal(ledger.valid, true, ledger.reasons.join("\n"));
  });

  await t.test(
    "rejects a noncanonical label even when group size is intact",
    () => {
      const mutated = structuredClone(events);
      for (const event of mutated) {
        if (event.contentSlot === "content-10") {
          event.contentSlot = "content-010";
        }
        if (Array.isArray(event.requests)) {
          for (const request of event.requests) {
            if (request.contentSlot === "content-10") {
              request.contentSlot = "content-010";
            }
          }
        }
      }
      const ledger = createRepresentativeTilesetRequestLedger(
        makeV2Diagnostics(mutated),
      );
      assert.equal(ledger.valid, false);
      assert.ok(
        ledger.reasons.some((reason) =>
          reason.includes("noncanonical or incomplete slots"),
        ),
      );
    },
  );
});

test("schema 2 fails closed on readiness and join mutations", async (t) => {
  const issued = v2Issue(1, "content-0", 1, 1, 1, 1);
  const baseline = [
    issued,
    v2Transition("completed", issued),
    v2Transition("content-created", issued, {
      contentType: "Model3DTileContent",
      modelPaths: ["model"],
    }),
    v2ModelEvent("model-ready", issued),
    v2ModelEvent("content-ready", issued),
    {
      type: "tile-ready",
      tile: issued.tile,
      contentKind: "multiple",
      contentSlot: "group",
      requests: [
        { contentSlot: "content-0", requestSerial: 1, groupSerial: 1 },
      ],
    },
  ];

  await t.test("missing model-ready", () => {
    const mutated = baseline.filter((event) => event.type !== "model-ready");
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(mutated),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("content became ready before the model"),
      ),
    );
  });

  await t.test("model readiness precedes content-created", () => {
    const mutated = [
      baseline[0],
      baseline[1],
      baseline[3],
      baseline[4],
      baseline[2],
      baseline[5],
    ];
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(mutated),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("occurred before content-created"),
      ),
    );
  });

  await t.test("content-ready precedes model-ready", () => {
    const mutated = [
      baseline[0],
      baseline[1],
      baseline[2],
      baseline[4],
      baseline[3],
      baseline[5],
    ];
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(mutated),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("content-ready before model-ready"),
      ),
    );
  });

  await t.test("tile-ready precedes model readiness", () => {
    const mutated = [
      baseline[0],
      baseline[1],
      baseline[2],
      baseline[5],
      baseline[3],
      baseline[4],
    ];
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(mutated),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("occurred before model model became content-ready"),
      ),
    );
  });

  await t.test("direct model declaration and readiness are both erased", () => {
    const mutated = structuredClone(
      baseline.filter(
        (event) =>
          event.type !== "model-ready" && event.type !== "content-ready",
      ),
    );
    mutated.find((event) => event.type === "content-created").modelPaths = [];
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(mutated),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("without its canonical model path"),
      ),
    );
  });

  await t.test("old-generation model settlement", () => {
    const mutated = structuredClone(baseline);
    mutated.find((event) => event.type === "model-ready").requestSerial = 2;
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(mutated),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) => reason.includes("changed serial")),
    );
  });

  await t.test("content factory outcome omitted", () => {
    const mutated = baseline.filter(
      (event) => event.type !== "content-created",
    );
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(mutated),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) => reason.includes("no content outcome")),
    );
  });

  await t.test("failed multiple slot outcome omitted", () => {
    const failed = v2Issue(9, "content-0", 1, 1, 1, 1);
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics([failed, v2Transition("failed", failed)]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) => reason.includes("no content outcome")),
    );
  });

  await t.test("tile-ready transition omitted", () => {
    const mutated = baseline.filter((event) => event.type !== "tile-ready");
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(mutated),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("no tile-ready transition"),
      ),
    );
  });

  await t.test("tile-ready omits a failed group slot", () => {
    const surviving = v2Issue(7, "content-0");
    const failed = v2Issue(8, "content-1");
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics([
        surviving,
        failed,
        v2Transition("completed", surviving),
        v2Transition("content-created", surviving, {
          contentType: "Model3DTileContent",
          modelPaths: ["model"],
        }),
        v2ModelEvent("model-ready", surviving),
        v2ModelEvent("content-ready", surviving),
        v2Transition("completed", failed),
        v2Transition("content-factory-failed", failed),
        {
          type: "tile-ready",
          tile: surviving.tile,
          contentKind: "multiple",
          contentSlot: "group",
          requests: [
            { contentSlot: "content-0", requestSerial: 1, groupSerial: 1 },
          ],
        },
      ]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("exact current request group"),
      ),
    );
  });

  await t.test("tile-ready references an old group after a reissue", () => {
    const oldRequest = v2Issue(10, "content-0", 1, 1, 1, 1);
    const reissue = v2Issue(11, "content-0", 2, 2, 2, 1);
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics([
        oldRequest,
        v2Transition("completed", oldRequest),
        v2Transition("content-factory-failed", oldRequest),
        reissue,
        {
          type: "tile-ready",
          tile: oldRequest.tile,
          contentKind: "multiple",
          contentSlot: "group",
          requests: [
            {
              contentSlot: "content-0",
              requestSerial: 1,
              groupSerial: 1,
            },
          ],
        },
      ]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("references a stale request group"),
      ),
    );
  });

  await t.test("duplicate tile-ready", () => {
    const mutated = [...baseline, structuredClone(baseline.at(-1))];
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(mutated),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("repeats a ready generation"),
      ),
    );
  });

  await t.test("instrumentation ambiguity", () => {
    const mutated = [
      ...baseline,
      {
        type: "instrumentation-ambiguity",
        tile: issued.tile,
        contentKind: "multiple",
        contentSlot: "unknown",
        reason: "request object reused",
      },
    ];
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(mutated),
    );
    assert.equal(ledger.valid, false);
    assert.ok(ledger.reasons.some((reason) => reason.includes("ambiguity")));
  });

  await t.test("truncation", () => {
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics(baseline, { eventsTruncated: true }),
    );
    assert.equal(ledger.valid, false);
    assert.ok(ledger.reasons.some((reason) => reason.includes("truncated")));
  });

  await t.test("missing group slot", () => {
    const grouped = v2Issue(7, "content-0");
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics([
        grouped,
        v2Transition("completed", grouped),
        v2Transition("content-factory-failed", grouped),
      ]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("noncanonical or incomplete slots"),
      ),
    );
  });

  await t.test("unbounded group size", () => {
    const grouped = v2Issue(7, "content-0", 1, 1, 1, 1_000_000_000);
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics([
        grouped,
        v2Transition("completed", grouped),
        v2Transition("content-factory-failed", grouped),
      ]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("noncanonical or incomplete slots"),
      ),
    );
  });

  await t.test("tile-ready references a discarded group", () => {
    const discarded = v2Issue(7, "content-0", 1, 1, 1, 1);
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics([
        discarded,
        v2Transition("cancelled", discarded),
        v2Transition("cancelled-settled", discarded),
        v2Transition("content-discarded", discarded),
        {
          type: "tile-ready",
          tile: discarded.tile,
          contentKind: "multiple",
          contentSlot: "group",
          requests: [
            {
              contentSlot: "content-0",
              requestSerial: 1,
              groupSerial: 1,
            },
          ],
        },
      ]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("references discarded content"),
      ),
    );
  });

  await t.test("group serial gap", () => {
    const first = v2Issue(7, "content-0", 1, 1, 2);
    const second = v2Issue(8, "content-1", 1, 1, 2);
    const ledger = createRepresentativeTilesetRequestLedger(
      makeV2Diagnostics([
        first,
        second,
        v2Transition("completed", first),
        v2Transition("content-factory-failed", first),
        v2Transition("completed", second),
        v2Transition("content-factory-failed", second),
      ]),
    );
    assert.equal(ledger.valid, false);
    assert.ok(
      ledger.reasons.some((reason) =>
        reason.includes("group serials are not contiguous"),
      ),
    );
  });
});

test("schema versions are explicit and never cross-compared", () => {
  const v1 = makeDiagnostics([
    issue(1, "tileset-0/root", 1, 1, 1),
    transition("completed", 1, "tileset-0/root", 1, 2),
  ]);
  const v2Issued = v2Issue(1, "content-0", 1, 1, 1, 1);
  const v2 = makeV2Diagnostics([
    v2Issued,
    v2Transition("completed", v2Issued),
    v2Transition("content-factory-failed", v2Issued),
  ]);
  const comparison = compareRepresentativeTilesetRequestLedgers(v1, v2);
  assert.equal(comparison.valid, false);
  assert.match(comparison.reasons[0], /schema mismatch/);

  const unsupported = createRepresentativeTilesetRequestLedger({
    schemaVersion: 3,
  });
  assert.equal(unsupported.valid, false);
  assert.match(unsupported.reasons[0], /unsupported/);
});
