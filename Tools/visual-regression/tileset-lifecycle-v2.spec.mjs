import assert from "node:assert/strict";
import test from "node:test";

import { createRepresentativeTilesetLifecycleTracker } from "./lib/representative-performance-content.mjs";

class FakeEvent {
  constructor() {
    this.listeners = new Set();
  }

  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  raise(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeRequest {
  constructor() {
    this.state = 2;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    this.state = 4;
  }
}

class FakeModel3DTileContent {
  constructor(tileset, tile) {
    this._tileset = tileset;
    this._tile = tile;
    this._model = { ready: false };
    this._ready = false;
    this.becomeReady = false;
    this.destroyed = false;
  }

  get tile() {
    return this._tile;
  }

  get innerContents() {
    return undefined;
  }

  get ready() {
    return this._ready;
  }

  update() {
    if (this.becomeReady) {
      this._model.ready = true;
      this._ready = true;
    }
  }

  destroy() {
    this.destroyed = true;
    return undefined;
  }
}

class FakeCompositeContent {
  constructor(contents) {
    this.innerContents = contents;
  }
}

class FakeMultiple3DTileContent {
  constructor(tileset, tile) {
    this._tileset = tileset;
    this._tile = tile;
    this._innerContentHeaders = [{}, {}];
    this._innerContentResources = [
      { url: "http://localhost/content-0.b3dm" },
      { url: "http://localhost/content-1.i3dm" },
    ];
    this._requests = [];
    this._arrayFetchPromises = [];
    this.generations = [];
    this.deferNext = false;
    this._contents = [];
  }

  get innerContents() {
    return this._contents;
  }

  requestInnerContents() {
    if (this.deferNext) {
      this.deferNext = false;
      return undefined;
    }
    const generation = this.generations.shift();
    if (!generation) {
      throw new Error("No fake multiple-content generation queued");
    }
    const requests = [new FakeRequest(), new FakeRequest()];
    this._requests = requests;
    this._arrayFetchPromises = generation.fetches.map((entry) => entry.promise);
    return Promise.all(this._arrayFetchPromises).then(() => {
      if (requests.some((request) => request.cancelled)) {
        return undefined;
      }
      this._contents = generation.contents.filter(Boolean);
      return generation.contents;
    });
  }

  cancelRequests() {
    for (const request of this._requests) {
      request.cancel();
    }
  }

  update() {
    for (const content of this._contents) {
      if (content instanceof FakeCompositeContent) {
        for (const innerContent of content.innerContents) {
          innerContent.update();
        }
      } else {
        content.update();
      }
    }
  }
}

class FakeTile {
  constructor(tileset) {
    this._tileset = tileset;
    this.parent = null;
    this.children = [];
    this.hasMultipleContents = true;
    this.hasEmptyContent = false;
    this.hasTilesetContent = false;
    this.hasImplicitContent = false;
    this._contentState = 1;
    this._contentResource = { url: "http://localhost/tileset.json" };
    this._content = new FakeMultiple3DTileContent(tileset, this);
    this.contentReady = false;
  }

  get content() {
    return this._content;
  }

  requestContent() {
    return this._content.requestInnerContents();
  }

  cancelRequests() {
    this._content.cancelRequests();
  }
}

function createHarness(options = {}) {
  const tileLoad = new FakeEvent();
  const tileset = {
    _root: null,
    _updatedVisibilityFrame: 7,
    tileLoad,
  };
  const tile = new FakeTile(tileset);
  tileset._root = tile;
  const resourceEntries = new Map();
  const C = {
    Cesium3DTile: FakeTile,
    Multiple3DTileContent: FakeMultiple3DTileContent,
    Model3DTileContent: FakeModel3DTileContent,
    RequestState: {
      ACTIVE: 2,
      RECEIVED: 3,
      CANCELLED: 4,
      FAILED: 5,
    },
    Cesium3DTileContentState: {
      LOADING: 1,
      PROCESSING: 2,
      READY: 3,
      FAILED: 5,
    },
  };
  const tracker = createRepresentativeTilesetLifecycleTracker(
    C,
    { tilesets: [tileset] },
    {
      schemaVersion: 2,
      baseUrl: "http://localhost/",
      performanceApi: {
        now: () => 12,
        getEntriesByName: (url) => resourceEntries.get(url) || [],
      },
      ...options,
    },
  );
  return { tile, tileLoad, tracker, resourceEntries };
}

function addResourceEntry(resourceEntries, url, value = 32) {
  const entries = resourceEntries.get(url) || [];
  entries.push({
    transferSize: value,
    encodedBodySize: value,
    decodedBodySize: value,
    duration: 1,
    responseEnd: 2,
    deliveryType: "",
  });
  resourceEntries.set(url, entries);
}

async function flushObservers() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("schema 2 observes real inner requests through model/content/tile readiness and restores prototypes", async () => {
  const originalMethods = {
    tileRequest: FakeTile.prototype.requestContent,
    tileCancel: FakeTile.prototype.cancelRequests,
    innerRequest: FakeMultiple3DTileContent.prototype.requestInnerContents,
    innerCancel: FakeMultiple3DTileContent.prototype.cancelRequests,
    modelUpdate: FakeModel3DTileContent.prototype.update,
    modelDestroy: FakeModel3DTileContent.prototype.destroy,
  };
  const { tile, tileLoad, tracker, resourceEntries } = createHarness();
  const firstFetch = deferred();
  const secondFetch = deferred();
  const firstModel = new FakeModel3DTileContent(tile._tileset, tile);
  const secondModel = new FakeModel3DTileContent(tile._tileset, tile);
  tile._content.generations.push({
    fetches: [firstFetch, secondFetch],
    contents: [firstModel, new FakeCompositeContent([secondModel])],
  });

  try {
    const result = tile.requestContent();
    addResourceEntry(resourceEntries, "http://localhost/content-0.b3dm", 40);
    addResourceEntry(resourceEntries, "http://localhost/content-1.i3dm", 60);
    firstFetch.resolve(new ArrayBuffer(4));
    secondFetch.resolve(new ArrayBuffer(8));
    await result;
    await flushObservers();

    firstModel.becomeReady = true;
    secondModel.becomeReady = true;
    tile._content.update();
    tile.contentReady = true;
    tile._contentState = 3;
    tileLoad.raise(tile);

    const diagnostics = tracker.snapshot();
    assert.equal(diagnostics.schemaVersion, 2);
    assert.equal(diagnostics.requestLedger.valid, true);
    assert.equal(diagnostics.requestLedger.complete, true);
    assert.equal(diagnostics.requestLedger.requestCount, 2);
    assert.equal(diagnostics.totals.multipleContentRequestAttempts, 2);
    assert.equal(diagnostics.totals.modelReadyEvents, 2);
    assert.equal(diagnostics.totals.contentReadyEvents, 2);
    assert.equal(diagnostics.totals.tileReadyEvents, 1);
    assert.deepEqual(
      diagnostics.requestLedger.readiness.models
        .map((model) => model.modelPath)
        .sort(),
      ["model", "composite/0/model"].sort(),
    );
    assert.ok(
      diagnostics.events.every(
        (event) => event.type !== "issued" || event.contentSlot !== "single",
      ),
    );
  } finally {
    tracker.destroy();
  }

  assert.equal(FakeTile.prototype.requestContent, originalMethods.tileRequest);
  assert.equal(FakeTile.prototype.cancelRequests, originalMethods.tileCancel);
  assert.equal(
    FakeMultiple3DTileContent.prototype.requestInnerContents,
    originalMethods.innerRequest,
  );
  assert.equal(
    FakeMultiple3DTileContent.prototype.cancelRequests,
    originalMethods.innerCancel,
  );
  assert.equal(
    FakeModel3DTileContent.prototype.update,
    originalMethods.modelUpdate,
  );
  assert.equal(
    FakeModel3DTileContent.prototype.destroy,
    originalMethods.modelDestroy,
  );
});

test("schema 2 keeps old cancelled generations separate from reissues", async () => {
  const { tile, tileLoad, tracker, resourceEntries } = createHarness();
  const oldFetches = [deferred(), deferred()];
  const newFetches = [deferred(), deferred()];
  const newModels = [
    new FakeModel3DTileContent(tile._tileset, tile),
    new FakeModel3DTileContent(tile._tileset, tile),
  ];
  tile._content.generations.push(
    {
      fetches: oldFetches,
      contents: [
        new FakeModel3DTileContent(tile._tileset, tile),
        new FakeModel3DTileContent(tile._tileset, tile),
      ],
    },
    { fetches: newFetches, contents: newModels },
  );

  try {
    const oldResult = tile.requestContent();
    tile.cancelRequests();
    const newResult = tile.requestContent();
    for (const url of [
      "http://localhost/content-0.b3dm",
      "http://localhost/content-1.i3dm",
    ]) {
      addResourceEntry(resourceEntries, url, 20);
      addResourceEntry(resourceEntries, url, 20);
    }

    newFetches[0].resolve(new ArrayBuffer(4));
    newFetches[1].resolve(new ArrayBuffer(4));
    await newResult;
    await flushObservers();
    oldFetches[0].resolve(undefined);
    oldFetches[1].resolve(undefined);
    await oldResult;
    await flushObservers();

    for (const model of newModels) {
      model.becomeReady = true;
    }
    tile._content.update();
    tile.contentReady = true;
    tile._contentState = 3;
    tileLoad.raise(tile);

    const diagnostics = tracker.snapshot();
    assert.equal(diagnostics.requestLedger.valid, true);
    assert.equal(diagnostics.totals.requestsCancelled, 2);
    assert.equal(diagnostics.totals.requestsReissued, 2);
    assert.equal(diagnostics.totals.requestsReissuedAfterCancellation, 2);
    assert.equal(
      diagnostics.requestLedger.requests.filter(
        (request) => request.terminalType === "cancelled-settled",
      ).length,
      2,
    );
    assert.ok(
      diagnostics.events
        .filter((event) => event.type === "content-discarded")
        .every((event) => event.requestSerial === 1),
    );
    assert.ok(
      diagnostics.events
        .filter((event) => event.type === "content-created")
        .every((event) => event.requestSerial === 2),
    );
  } finally {
    tracker.destroy();
  }
});

test("schema 2 discards an entire cancelled group after one slot already completed", async () => {
  const { tile, tileLoad, tracker, resourceEntries } = createHarness();
  const oldFetches = [deferred(), deferred()];
  const newFetches = [deferred(), deferred()];
  const newModels = [
    new FakeModel3DTileContent(tile._tileset, tile),
    new FakeModel3DTileContent(tile._tileset, tile),
  ];
  tile._content.generations.push(
    {
      fetches: oldFetches,
      contents: [
        new FakeModel3DTileContent(tile._tileset, tile),
        new FakeModel3DTileContent(tile._tileset, tile),
      ],
    },
    { fetches: newFetches, contents: newModels },
  );
  try {
    const oldResult = tile.requestContent();
    addResourceEntry(resourceEntries, "http://localhost/content-0.b3dm", 20);
    oldFetches[0].resolve(new ArrayBuffer(4));
    await flushObservers();
    tile.cancelRequests();
    const newResult = tile.requestContent();
    addResourceEntry(resourceEntries, "http://localhost/content-0.b3dm", 20);
    addResourceEntry(resourceEntries, "http://localhost/content-1.i3dm", 20);
    addResourceEntry(resourceEntries, "http://localhost/content-1.i3dm", 20);
    oldFetches[1].resolve(undefined);
    await oldResult;
    await flushObservers();
    newFetches[0].resolve(new ArrayBuffer(4));
    newFetches[1].resolve(new ArrayBuffer(4));
    await newResult;
    await flushObservers();

    for (const model of newModels) {
      model.becomeReady = true;
    }
    tile._content.update();
    tile.contentReady = true;
    tile._contentState = 3;
    tileLoad.raise(tile);

    const diagnostics = tracker.snapshot();
    assert.equal(diagnostics.requestLedger.valid, true);
    assert.equal(diagnostics.totals.requestsCancelled, 1);
    assert.equal(diagnostics.totals.requestCancellationNoops, 1);
    assert.equal(diagnostics.totals.requestsReissued, 2);
    assert.equal(diagnostics.totals.requestsReissuedAfterCancellation, 1);
    const oldRequests = diagnostics.requestLedger.requests.filter(
      (request) => request.requestSerial === 1,
    );
    assert.deepEqual(
      oldRequests.map((request) => request.terminalType).sort(),
      ["cancelled-settled", "completed"],
    );
    assert.deepEqual(
      diagnostics.events
        .filter(
          (event) =>
            event.type === "content-discarded" && event.requestSerial === 1,
        )
        .map((event) => event.contentSlot)
        .sort(),
      ["content-0", "content-1"],
    );
    assert.equal(
      diagnostics.events.some(
        (event) =>
          event.type === "content-factory-failed" && event.requestSerial === 1,
      ),
      false,
    );
    assert.equal(
      diagnostics.events.filter(
        (event) => event.type === "cancel-requested-noop",
      ).length,
      1,
    );
  } finally {
    tracker.destroy();
  }
});

test("schema 2 recognizes scheduler cancellation without cancelRequests", async () => {
  const { tile, tracker, resourceEntries } = createHarness();
  const fetches = [deferred(), deferred()];
  tile._content.generations.push({
    fetches,
    contents: [
      new FakeModel3DTileContent(tile._tileset, tile),
      new FakeModel3DTileContent(tile._tileset, tile),
    ],
  });
  try {
    const result = tile.requestContent();
    addResourceEntry(resourceEntries, "http://localhost/content-0.b3dm");
    addResourceEntry(resourceEntries, "http://localhost/content-1.i3dm");
    tile._content._requests[1].cancel();
    fetches[0].resolve(new ArrayBuffer(4));
    fetches[1].resolve(undefined);
    await result;
    await flushObservers();

    const diagnostics = tracker.snapshot();
    assert.equal(diagnostics.requestLedger.valid, true);
    assert.equal(diagnostics.totals.requestsCancelled, 1);
    assert.equal(
      diagnostics.events.filter((event) => event.type === "content-discarded")
        .length,
      2,
    );
  } finally {
    tracker.destroy();
  }
});

test("schema 2 orders a completed-slot cancellation race before group discard", async () => {
  const { tile, tracker, resourceEntries } = createHarness();
  const fetches = [deferred(), deferred()];
  tile._content.generations.push({
    fetches,
    contents: [
      new FakeModel3DTileContent(tile._tileset, tile),
      new FakeModel3DTileContent(tile._tileset, tile),
    ],
  });
  try {
    const result = tile.requestContent();
    addResourceEntry(resourceEntries, "http://localhost/content-0.b3dm");
    addResourceEntry(resourceEntries, "http://localhost/content-1.i3dm");
    fetches[0].resolve(new ArrayBuffer(4));
    tile._content._requests[0].cancel();
    fetches[1].resolve(undefined);
    await result;
    await flushObservers();

    const diagnostics = tracker.snapshot();
    assert.equal(diagnostics.requestLedger.valid, true);
    assert.equal(diagnostics.totals.requestsCancelled, 0);
    assert.equal(diagnostics.totals.requestCancellationNoops, 1);
    assert.deepEqual(
      diagnostics.events
        .filter((event) => event.contentSlot === "content-0")
        .map((event) => event.type),
      ["issued", "completed", "cancel-requested-noop", "content-discarded"],
    );
  } finally {
    tracker.destroy();
  }
});

test("schema 2 observes direct cancellation after a slot already settled", async () => {
  const { tile, tracker, resourceEntries } = createHarness();
  const fetches = [deferred(), deferred()];
  tile._content.generations.push({
    fetches,
    contents: [
      new FakeModel3DTileContent(tile._tileset, tile),
      new FakeModel3DTileContent(tile._tileset, tile),
    ],
  });
  try {
    const result = tile.requestContent();
    addResourceEntry(resourceEntries, "http://localhost/content-0.b3dm");
    addResourceEntry(resourceEntries, "http://localhost/content-1.i3dm");
    fetches[0].resolve(new ArrayBuffer(4));
    await flushObservers();
    tile._content._requests[0].cancel();
    fetches[1].resolve(undefined);
    await result;
    await flushObservers();

    const diagnostics = tracker.snapshot();
    assert.equal(diagnostics.requestLedger.valid, true);
    assert.equal(diagnostics.totals.requestCancellationNoops, 1);
    assert.deepEqual(
      diagnostics.events
        .filter((event) => event.contentSlot === "content-0")
        .map((event) => event.type),
      ["issued", "completed", "cancel-requested-noop", "content-discarded"],
    );
  } finally {
    tracker.destroy();
  }
});

test("schema 2 records per-slot deferral, factory failure, and destroy-before-ready", async () => {
  const { tile, tileLoad, tracker, resourceEntries } = createHarness();
  tile._content.deferNext = true;
  assert.equal(tile.requestContent(), undefined);

  const fetches = [deferred(), deferred()];
  const model = new FakeModel3DTileContent(tile._tileset, tile);
  tile._content.generations.push({
    fetches,
    contents: [model, undefined],
  });
  try {
    const result = tile.requestContent();
    addResourceEntry(resourceEntries, "http://localhost/content-0.b3dm");
    addResourceEntry(resourceEntries, "http://localhost/content-1.i3dm");
    fetches[0].resolve(new ArrayBuffer(4));
    fetches[1].resolve(new ArrayBuffer(4));
    await result;
    await flushObservers();
    model.becomeReady = true;
    tile._content.update();
    tile.contentReady = true;
    tile._contentState = 3;
    tileLoad.raise(tile);

    const diagnostics = tracker.snapshot();
    assert.equal(diagnostics.requestLedger.valid, true);
    assert.equal(diagnostics.totals.requestSchedulingDeferrals, 2);
    assert.equal(diagnostics.totals.contentFactoryFailures, 1);
    assert.deepEqual(
      diagnostics.requestLedger.requests.map(
        (request) => request.attemptSerial,
      ),
      [2, 2],
    );
  } finally {
    tracker.destroy();
  }

  const secondHarness = createHarness();
  const destroyFetches = [deferred(), deferred()];
  const doomed = new FakeModel3DTileContent(
    secondHarness.tile._tileset,
    secondHarness.tile,
  );
  secondHarness.tile._content.generations.push({
    fetches: destroyFetches,
    contents: [doomed, undefined],
  });
  try {
    const result = secondHarness.tile.requestContent();
    addResourceEntry(
      secondHarness.resourceEntries,
      "http://localhost/content-0.b3dm",
    );
    addResourceEntry(
      secondHarness.resourceEntries,
      "http://localhost/content-1.i3dm",
    );
    destroyFetches[0].resolve(new ArrayBuffer(4));
    destroyFetches[1].resolve(new ArrayBuffer(4));
    await result;
    await flushObservers();
    doomed.destroy();
    const diagnostics = secondHarness.tracker.snapshot();
    assert.equal(diagnostics.requestLedger.valid, true);
    assert.equal(diagnostics.totals.modelDestroyedBeforeReadyEvents, 1);
  } finally {
    secondHarness.tracker.destroy();
  }
});

test("schema 1 backfills reissue-after-cancellation when old settlement is late", async () => {
  class FakeSingleTile {
    constructor(tileset) {
      this._tileset = tileset;
      this.parent = null;
      this.children = [];
      this.hasMultipleContents = false;
      this.hasEmptyContent = false;
      this.hasTilesetContent = false;
      this.hasImplicitContent = false;
      this._contentState = 1;
      this._contentResource = { url: "http://localhost/single.b3dm" };
      this.pending = [];
      this.contentReady = false;
      this.content = {};
    }

    requestContent() {
      this._request = new FakeRequest();
      return this.pending.shift().promise;
    }

    cancelRequests() {
      this._request.cancel();
    }
  }

  const tileLoad = new FakeEvent();
  const tileset = {
    _root: null,
    _updatedVisibilityFrame: 3,
    tileLoad,
  };
  const tile = new FakeSingleTile(tileset);
  tileset._root = tile;
  const oldRequest = deferred();
  const newRequest = deferred();
  tile.pending.push(oldRequest, newRequest);
  const entries = [];
  const tracker = createRepresentativeTilesetLifecycleTracker(
    {
      Cesium3DTile: FakeSingleTile,
      RequestState: { ACTIVE: 2, RECEIVED: 3, CANCELLED: 4, FAILED: 5 },
      Cesium3DTileContentState: { LOADING: 1, READY: 3 },
    },
    { tilesets: [tileset] },
    {
      schemaVersion: 1,
      performanceApi: {
        now: () => 1,
        getEntriesByName: () => entries,
      },
    },
  );
  try {
    const oldResult = tile.requestContent();
    tile.cancelRequests();
    const newResult = tile.requestContent();
    entries.push({
      transferSize: 10,
      encodedBodySize: 10,
      decodedBodySize: 10,
    });
    oldRequest.resolve(undefined);
    await oldResult;
    await flushObservers();
    entries.push({
      transferSize: 10,
      encodedBodySize: 10,
      decodedBodySize: 10,
    });
    newRequest.resolve({ ready: true });
    await newResult;
    await flushObservers();
    tile.contentReady = true;
    tile._contentState = 3;
    tileLoad.raise(tile);

    const diagnostics = tracker.snapshot();
    assert.equal(diagnostics.requestLedger.valid, true);
    assert.equal(diagnostics.totals.requestsReissuedAfterCancellation, 1);
  } finally {
    tracker.destroy();
  }
});

test("destroy freezes diagnostics before pending async observers settle", async () => {
  const { tile, tracker } = createHarness();
  const fetches = [deferred(), deferred()];
  tile._content.generations.push({
    fetches,
    contents: [
      new FakeModel3DTileContent(tile._tileset, tile),
      new FakeModel3DTileContent(tile._tileset, tile),
    ],
  });
  const result = tile.requestContent();
  const beforeDestroy = tracker.snapshot();
  tracker.destroy();

  fetches[0].resolve(new ArrayBuffer(4));
  fetches[1].resolve(new ArrayBuffer(4));
  await result;
  await flushObservers();
  const afterSettlement = tracker.snapshot();

  assert.deepEqual(afterSettlement.totals, beforeDestroy.totals);
  assert.deepEqual(afterSettlement.events, beforeDestroy.events);
  assert.deepEqual(afterSettlement.requestLedger, beforeDestroy.requestLedger);
});
