// @purpose Q-146: prove the earth-at-night demo's clock coupling is scoped to
// the Dynamic-lighting checkbox alone, and that the Clock actually supplied to
// Viewer has a pinned currentTime inside its own [startTime, stopTime] window.
// Text-lifts the real gallery source between unique anchors and evaluates it
// against stub Viewer/Clock/knockout harnesses -- no browser, no Cesium import
// (this clone's node_modules junction resolves @cesium/engine into a different,
// independently-moving repository; a demo-logic proof must not depend on that
// tree's live state).
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "..", "..");
const MAIN_JS_PATH = path.join(
  REPOSITORY_ROOT,
  "packages",
  "sandcastle",
  "gallery",
  "earth-at-night",
  "main.js",
);

// Normalized to LF immediately on read: this Windows checkout has
// core.autocrlf=true, so the working-tree file (like every other file in the
// gallery) carries CRLF line endings even though git's stored blob is LF.
// Anchor and mutant text below is authored LF-only; matching it against raw
// CRLF source would silently find zero occurrences instead of one.
const SOURCE = fs.readFileSync(MAIN_JS_PATH, "utf8").replace(/\r\n/g, "\n");

// --- Anchor-based extraction -----------------------------------------------
//
// The first pair brackets the real Clock construction and Viewer.createAsync
// call. The second pair lifts everything after Viewer construction through the
// initial update calls, so direct post-construction clock writes and subsequent
// observable-driven writes are executed by the behavioural harness. The
// narrower setup block remains the input to the clock-coupling tests below.
//
// Every anchor is asserted unique before extraction, so a future edit that
// duplicates or removes one fails loudly instead of silently lifting the wrong
// span.

const CLOCK_VIEWER_START_ANCHOR = "const clock = new Cesium.Clock({";
const POST_CONSTRUCTION_START_ANCHOR = "const scene = viewer.scene;";
const SETUP_START_ANCHOR = "const viewModel = {";
const SETUP_END_ANCHOR = "updateDynamicLighting();";
const VIEWER_CREATE_ANCHOR =
  'const viewer = await Cesium.Viewer.createAsync("cesiumContainer", {';

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count += 1;
    from = at + needle.length;
  }
}

function extractBetween(
  source,
  startAnchor,
  endAnchor,
  { includeEnd = true } = {},
) {
  const startCount = countOccurrences(source, startAnchor);
  assert.equal(
    startCount,
    1,
    `expected exactly one occurrence of start anchor ${JSON.stringify(startAnchor)}, found ${startCount}`,
  );

  const endCount = countOccurrences(source, endAnchor);
  assert.equal(
    endCount,
    1,
    `expected exactly one occurrence of end anchor ${JSON.stringify(endAnchor)}, found ${endCount}`,
  );

  const start = source.indexOf(startAnchor);
  const endStart = source.indexOf(endAnchor);
  assert.ok(endStart > start, "end anchor must follow start anchor");

  const end = includeEnd ? endStart + endAnchor.length : endStart;
  return source.slice(start, end);
}

const clockViewerBlock = extractBetween(
  SOURCE,
  CLOCK_VIEWER_START_ANCHOR,
  POST_CONSTRUCTION_START_ANCHOR,
  { includeEnd: false },
);
const postConstructionBlock = extractBetween(
  SOURCE,
  POST_CONSTRUCTION_START_ANCHOR,
  SETUP_END_ANCHOR,
);
const setupBlock = extractBetween(SOURCE, SETUP_START_ANCHOR, SETUP_END_ANCHOR);

const viewerCreateOccurrences = countOccurrences(SOURCE, VIEWER_CREATE_ANCHOR);
assert.equal(
  viewerCreateOccurrences,
  1,
  `expected exactly one Viewer.createAsync call-site anchor, found ${viewerCreateOccurrences}`,
);
assert.equal(
  countOccurrences(clockViewerBlock, VIEWER_CREATE_ANCHOR),
  1,
  "the lifted Clock/Viewer block must contain the unique Viewer.createAsync call site",
);

// --- Clock-construction and Viewer-wiring harness --------------------------
//
// The stubs intentionally model only the observable behaviour under test:
// Clock records the constructor values and every later currentTime assignment;
// JulianDate produces comparable numeric instants; ClockViewModel records the
// Clock it wraps; and Viewer.createAsync records the exact options it receives
// while constructing a default Clock when no clockViewModel is supplied.

function makeClockCesiumHarness() {
  const defaultClockRange = Symbol("ClockRange.UNBOUNDED");
  const records = {
    clockConstructorOptions: [],
    clocks: [],
    clockViewModels: [],
    viewerCreateAsyncCalls: [],
    cameraSetViewCalls: [],
  };

  class Clock {
    constructor(options = {}) {
      records.clockConstructorOptions.push(options);

      this.startTime = options.startTime;
      this.stopTime = options.stopTime;
      this.multiplier = Object.hasOwn(options, "multiplier")
        ? options.multiplier
        : 1;
      this.clockRange = Object.hasOwn(options, "clockRange")
        ? options.clockRange
        : defaultClockRange;
      this.shouldAnimate = Object.hasOwn(options, "shouldAnimate")
        ? options.shouldAnimate
        : false;

      let currentTime = options.currentTime;
      this.constructedCurrentTime = currentTime;
      this.currentTimeAssignments = [];
      Object.defineProperty(this, "currentTime", {
        enumerable: true,
        configurable: true,
        get() {
          return currentTime;
        },
        set(next) {
          this.currentTimeAssignments.push(next);
          currentTime = next;
        },
      });

      records.clocks.push(this);
    }
  }

  class ClockViewModel {
    constructor(clock) {
      this.clock = clock;
      records.clockViewModels.push(this);
    }
  }

  const globe = {};
  const scene = {
    globe,
    camera: {
      setView(options) {
        records.cameraSetViewCalls.push(options);
      },
    },
    context: {
      rendererType: "stub-renderer",
    },
  };

  const CesiumStub = {
    Clock,
    ClockRange: Object.freeze({
      UNBOUNDED: defaultClockRange,
      CLAMPED: Symbol("ClockRange.CLAMPED"),
      LOOP_STOP: Symbol("ClockRange.LOOP_STOP"),
    }),
    ClockViewModel,
    JulianDate: {
      fromIso8601(iso8601) {
        const value = Date.parse(iso8601);
        assert.ok(
          Number.isFinite(value),
          `JulianDate.fromIso8601 received an invalid value: ${iso8601}`,
        );
        return value;
      },
    },
    Viewer: {
      async createAsync(container, options) {
        records.viewerCreateAsyncCalls.push({ container, options });
        const viewerClock = options?.clockViewModel?.clock ?? new Clock();
        return {
          clock: viewerClock,
          scene,
        };
      },
    },
    Cartesian3: {
      fromDegrees(longitude, latitude, height) {
        return { longitude, latitude, height };
      },
    },
    IonImageryProvider: {
      fromAssetId(assetId) {
        return { assetId };
      },
    },
    knockout: makeKnockoutStub(),
    defined(x) {
      return x !== undefined && x !== null;
    },
  };

  return {
    CesiumStub,
    defaults: {
      clockRange: defaultClockRange,
    },
    records,
  };
}

async function runClockAndPostConstructionBlocks() {
  const harness = makeClockCesiumHarness();
  const documentStub = {
    getElementById() {
      return {};
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  const factory = new AsyncFunction(
    "Cesium",
    "document",
    `${clockViewerBlock}
${postConstructionBlock}
return { clock, viewer, scene, globe, viewModel };`,
  );

  const result = await factory(harness.CesiumStub, documentStub);
  return { ...harness, ...result };
}

test("Q-146: Viewer receives the constructed, bracketed Clock through ClockViewModel", async () => {
  const { clock, viewer, defaults, records, CesiumStub } =
    await runClockAndPostConstructionBlocks();

  assert.equal(
    records.viewerCreateAsyncCalls.length,
    1,
    "the lifted call site must invoke Viewer.createAsync exactly once",
  );
  assert.equal(
    records.clockViewModels.length,
    1,
    "the lifted call site must construct exactly one ClockViewModel",
  );
  assert.equal(
    records.clocks.length,
    1,
    "Viewer must use the explicitly constructed Clock rather than constructing a default one",
  );

  const viewerCall = records.viewerCreateAsyncCalls[0];
  assert.equal(viewerCall.container, "cesiumContainer");
  assert.ok(
    viewerCall.options.clockViewModel instanceof CesiumStub.ClockViewModel,
    "Viewer.createAsync must receive a ClockViewModel",
  );
  assert.equal(
    viewerCall.options.clockViewModel.clock,
    clock,
    "the ClockViewModel must wrap the Clock constructed by the lifted block",
  );
  assert.equal(
    viewer.clock,
    clock,
    "the Viewer's clock must be the explicitly constructed Clock",
  );

  assert.equal(clock.startTime, Date.parse("2026-03-21T00:00:00Z"));
  assert.equal(clock.currentTime, Date.parse("2026-03-21T02:00:00Z"));
  assert.equal(clock.stopTime, Date.parse("2026-03-22T00:00:00Z"));
  assert.ok(
    clock.startTime <= clock.currentTime,
    "startTime must be <= currentTime on the Viewer clock",
  );
  assert.ok(
    clock.currentTime <= clock.stopTime,
    "currentTime must be <= stopTime on the Viewer clock",
  );
  assert.ok(
    clock.startTime < clock.stopTime,
    "startTime must be < stopTime on the Viewer clock",
  );

  assert.equal(clock.multiplier, 4000, "the Viewer clock must retain 4000x");
  assert.equal(
    clock.clockRange,
    defaults.clockRange,
    "the Viewer clock must retain Clock's default UNBOUNDED range",
  );
  assert.equal(
    Object.hasOwn(records.clockConstructorOptions[0], "clockRange"),
    false,
    "the demo must leave clockRange at the Clock constructor's default",
  );
});

test("Q-146: the lifted post-construction controls never replace the constructed currentTime", async () => {
  const { clock, viewer, viewModel } =
    await runClockAndPostConstructionBlocks();
  const constructedCurrentTime = clock.constructedCurrentTime;

  assert.equal(
    viewer.clock.currentTime,
    constructedCurrentTime,
    "executing the lifted post-construction block must leave currentTime unchanged",
  );
  assert.deepEqual(
    clock.currentTimeAssignments,
    [],
    "the lifted post-construction block must not assign currentTime",
  );

  const controlChanges = [
    ["nightImagery", "off"],
    ["nightDarkness", 0.7],
    ["enableNightLights", false],
    ["nightIntensity", 4.0],
    ["dynamicLighting", true],
    ["dynamicLighting", false],
  ];
  for (const [name, value] of controlChanges) {
    viewModel[name] = value;
    assert.equal(
      viewer.clock.currentTime,
      constructedCurrentTime,
      `currentTime must remain unchanged after driving "${name}"`,
    );
  }

  assert.deepEqual(
    clock.currentTimeAssignments,
    [],
    "no observable-driven post-construction path may assign currentTime",
  );
});

// --- Clock-coupling harness -------------------------------------------------
//
// Mimics just enough of Cesium.knockout for the extracted setup block to run:
// `track` makes each own-enumerable property an accessor that notifies its
// subscribers on write; `getObservable(obj, name).subscribe(fn)` registers a
// subscriber for that property name; `applyBindings` is a no-op (DOM binding
// isn't under test here).

function makeKnockoutStub() {
  const subscribersByName = new Map();
  return {
    track(obj) {
      for (const key of Object.keys(obj)) {
        let value = obj[key];
        subscribersByName.set(key, []);
        Object.defineProperty(obj, key, {
          enumerable: true,
          configurable: true,
          get() {
            return value;
          },
          set(next) {
            value = next;
            for (const fn of subscribersByName.get(key)) {
              fn(next);
            }
          },
        });
      }
    },
    applyBindings() {},
    getObservable(_obj, name) {
      assert.ok(
        subscribersByName.has(name),
        `getObservable called for untracked property "${name}"`,
      );
      return {
        subscribe(fn) {
          subscribersByName.get(name).push(fn);
        },
      };
    },
  };
}

/**
 * Evaluates a setup-block source string against a fresh harness and returns
 * the resulting viewModel/globe/viewer/clock handles so a test can drive
 * further interactions.
 */
function runSetupBlock(blockSource) {
  const globe = {};
  const viewer = { clock: { shouldAnimate: false } };
  const documentStub = {
    getElementById() {
      return {};
    },
  };
  const CesiumStub = {
    knockout: makeKnockoutStub(),
    defined(x) {
      return x !== undefined && x !== null;
    },
  };
  function resolveNightImagery(choice) {
    // Irrelevant to clock-coupling behaviour; any deterministic stand-in is
    // fine since no assertion below reads globe.nightImagery.
    return choice;
  }

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "Cesium",
    "globe",
    "viewer",
    "document",
    "resolveNightImagery",
    `${blockSource}\nreturn { viewModel, updateGlobe, updateDynamicLighting };`,
  );
  const { viewModel } = factory(
    CesiumStub,
    globe,
    viewer,
    documentStub,
    resolveNightImagery,
  );

  return { viewModel, globe, viewer };
}

test("Q-146 (a): lighting OFF, fast-forwarded -- the other four controls never touch the clock", () => {
  const { viewModel, viewer } = runSetupBlock(setupBlock);
  assert.equal(viewModel.dynamicLighting, false, "starts with lighting off");

  // Simulate the Animation widget's play button: it writes shouldAnimate
  // directly, outside the knockout subscription graph under test here.
  viewer.clock.shouldAnimate = true;

  const otherControls = [
    ["nightImagery", "off"],
    ["nightDarkness", 0.5],
    ["enableNightLights", false],
    ["nightIntensity", 4.0],
  ];
  for (const [name, value] of otherControls) {
    viewModel[name] = value;
    assert.equal(
      viewer.clock.shouldAnimate,
      true,
      `clock.shouldAnimate must be unchanged after nudging "${name}"`,
    );
  }
});

test("Q-146 (b): lighting ON then paused -- nudging a slider leaves the clock paused", () => {
  const { viewModel, viewer } = runSetupBlock(setupBlock);

  viewModel.dynamicLighting = true;
  assert.equal(
    viewer.clock.shouldAnimate,
    true,
    "checkbox ON starts the clock",
  );

  // Simulate pressing pause: the Animation widget writes shouldAnimate
  // directly, same as the play button above.
  viewer.clock.shouldAnimate = false;

  viewModel.nightDarkness = 0.7;
  assert.equal(
    viewer.clock.shouldAnimate,
    false,
    "clock.shouldAnimate must stay false after nudging a slider while paused",
  );
});

test("Q-146: the dynamicLighting observable alone flips shouldAnimate", () => {
  const { viewModel, viewer } = runSetupBlock(setupBlock);

  viewModel.dynamicLighting = true;
  assert.equal(viewer.clock.shouldAnimate, true);

  viewModel.dynamicLighting = false;
  assert.equal(viewer.clock.shouldAnimate, false);
});

// --- Inertness mutant --------------------------------------------------
//
// Re-introduces the original defect shape: every one of the five observables
// is subscribed only to the shared updateGlobe function, and updateGlobe itself
// writes shouldAnimate. Thus any control change reaches the clock write. Both
// mutations are literal substitutions on real, uniquely verified text, so the
// mutant is the same implementation wired in the original unfiltered shape
// rather than a hand-authored stand-in.

const REAL_SUBSCRIPTION_TEXT = `for (const name of [
  "nightImagery",
  "nightDarkness",
  "enableNightLights",
  "nightIntensity",
]) {
  Cesium.knockout.getObservable(viewModel, name).subscribe(updateGlobe);
}
Cesium.knockout
  .getObservable(viewModel, "dynamicLighting")
  .subscribe(updateDynamicLighting);`;

const MUTANT_SUBSCRIPTION_TEXT = `for (const name in viewModel) {
  if (viewModel.hasOwnProperty(name)) {
    Cesium.knockout.getObservable(viewModel, name).subscribe(updateGlobe);
  }
}`;

const REAL_UPDATE_GLOBE_TAIL = `  globe.enableNightLights = Boolean(viewModel.enableNightLights);
  globe.nightIntensity = Number(viewModel.nightIntensity);
}`;

const MUTANT_UPDATE_GLOBE_TAIL = `  globe.enableNightLights = Boolean(viewModel.enableNightLights);
  globe.nightIntensity = Number(viewModel.nightIntensity);

  const dynamicLighting = Boolean(viewModel.dynamicLighting);
  globe.enableLighting = dynamicLighting;
  viewer.clock.shouldAnimate = dynamicLighting;
}`;

test("Q-146 mutant: re-pointing the clock write at the unfiltered subscription must fail leg (a)", () => {
  const subscriptionOccurrences = countOccurrences(
    setupBlock,
    REAL_SUBSCRIPTION_TEXT,
  );
  assert.equal(
    subscriptionOccurrences,
    1,
    "expected the real filtered-subscription text to appear exactly once in the setup block",
  );

  const updateGlobeTailOccurrences = countOccurrences(
    setupBlock,
    REAL_UPDATE_GLOBE_TAIL,
  );
  assert.equal(
    updateGlobeTailOccurrences,
    1,
    "expected the real updateGlobe tail to appear exactly once in the setup block",
  );

  const mutantBlock = setupBlock
    .replace(REAL_SUBSCRIPTION_TEXT, MUTANT_SUBSCRIPTION_TEXT)
    .replace(REAL_UPDATE_GLOBE_TAIL, MUTANT_UPDATE_GLOBE_TAIL);
  assert.notEqual(
    mutantBlock,
    setupBlock,
    "mutation must actually change the text",
  );

  const { viewModel, viewer } = runSetupBlock(mutantBlock);
  viewer.clock.shouldAnimate = true; // fast-forward, lighting OFF

  let sawMismatch = false;
  try {
    viewModel.nightDarkness = 0.9; // one of the "other four" controls
    assert.equal(viewer.clock.shouldAnimate, true);
  } catch {
    sawMismatch = true;
  }

  assert.equal(
    sawMismatch,
    true,
    "leg (a) must go red under the unfiltered-subscription mutant (the clock stopped when a non-lighting control changed)",
  );
});
