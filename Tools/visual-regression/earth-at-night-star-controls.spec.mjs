// @purpose EAN-01: prove the earth-at-night star-map, HDR-plus-bloom, and
// star-field-intensity controls are subscriber-only, destroy live sky boxes,
// and never inherit the Dynamic-lighting control's clock coupling.
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

const SOURCE = fs.readFileSync(MAIN_JS_PATH, "utf8").replace(/\r\n/g, "\n");

const DEFAULTS_START_ANCHOR = "// EAN-01 star-control defaults: begin.";
const DEFAULTS_END_ANCHOR = "// EAN-01 star-control defaults: end.";
const CONTROL_START_ANCHOR = "// EAN-01 star-control wiring: begin.";
const CONTROL_END_ANCHOR = "// EAN-01 star-control wiring: end.";

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;

  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return count;
    }
    count++;
    from = at + needle.length;
  }
}

function liftInclusive(source, startAnchor, endAnchor) {
  assert.equal(countOccurrences(source, startAnchor), 1);
  assert.equal(countOccurrences(source, endAnchor), 1);

  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start) + endAnchor.length;
  return source.slice(start, end);
}

const CONTROL_DEFAULTS = liftInclusive(
  SOURCE,
  DEFAULTS_START_ANCHOR,
  DEFAULTS_END_ANCHOR,
);
const CONTROL_WIRING = liftInclusive(
  SOURCE,
  CONTROL_START_ANCHOR,
  CONTROL_END_ANCHOR,
);

function createHarness(
  controlSource = CONTROL_WIRING,
  defaultsSource = CONTROL_DEFAULTS,
) {
  const subscriptions = new Map();
  const createCalls = [];
  const destroyedSkyBoxes = [];
  let clockWrites = 0;
  let shouldAnimate = false;

  function makeSkyBox(label) {
    return {
      label,
      destroyCalls: 0,
      starField: {
        intensity: 1.0,
      },
      destroy() {
        this.destroyCalls++;
        destroyedSkyBoxes.push(this);
      },
    };
  }

  const previousSkyBox = makeSkyBox("initial");
  const scene = {
    skyBox: previousSkyBox,
    highDynamicRange: false,
    postProcessStages: {
      bloom: {
        enabled: false,
      },
    },
  };

  const clock = {};
  Object.defineProperty(clock, "shouldAnimate", {
    configurable: true,
    get() {
      return shouldAnimate;
    },
    set(value) {
      clockWrites++;
      shouldAnimate = value;
    },
  });

  const viewer = {
    scene,
    clock,
  };

  const Cesium = {
    SkyBox: {
      defaultVariant: "TYCHO_T5_DIFFUSE",
      Variant: Object.freeze({
        TYCHO_T5: "TYCHO_T5",
        TYCHO_T5_DIFFUSE: "TYCHO_T5_DIFFUSE",
      }),
      createEarthSkyBox() {
        createCalls.push(this.defaultVariant);
        return makeSkyBox(`created-${createCalls.length}`);
      },
    },
    knockout: {
      getObservable(_viewModel, name) {
        return {
          subscribe(callback) {
            const callbacks = subscriptions.get(name) ?? [];
            callbacks.push(callback);
            subscriptions.set(name, callbacks);
          },
        };
      },
    },
  };

  const viewModel = {};

  // The lifted gallery source must run inside this isolated fake-Cesium harness.
  // eslint-disable-next-line no-new-func
  const loadControls = new Function(
    "Cesium",
    "viewer",
    "scene",
    "viewModel",
    `${defaultsSource}
${controlSource}
return { viewModel, wireStarControls };`,
  );
  const controls = loadControls(Cesium, viewer, scene, viewModel);
  controls.wireStarControls(controls.viewModel, scene);

  function emit(name) {
    const callbacks = subscriptions.get(name);
    assert.ok(callbacks, `expected a subscription for ${name}`);
    for (const callback of callbacks) {
      callback();
    }
  }

  return {
    Cesium,
    createCalls,
    destroyedSkyBoxes,
    emit,
    previousSkyBox,
    scene,
    viewModel: controls.viewModel,
    get clockWrites() {
      return clockWrites;
    },
  };
}

function exerciseVariantSwap(controlSource = CONTROL_WIRING) {
  const harness = createHarness(controlSource);
  harness.viewModel.starMap = "TYCHO_T5";
  harness.emit("starMap");

  assert.equal(
    harness.previousSkyBox.destroyCalls,
    1,
    "previous sky box must be destroyed",
  );
  return harness;
}

test("default star controls leave the engine state unchanged", () => {
  const harness = createHarness();

  assert.equal(harness.viewModel.starMap, "TYCHO_T5_DIFFUSE");
  assert.equal(harness.viewModel.hdrBloom, false);
  assert.equal(harness.viewModel.starFieldIntensity, 1.0);
  assert.deepEqual(harness.createCalls, []);
  assert.deepEqual(harness.destroyedSkyBoxes, []);
  assert.equal(harness.scene.highDynamicRange, false);
  assert.equal(harness.scene.postProcessStages.bloom.enabled, false);
  assert.equal(harness.clockWrites, 0);
});

test("TYCHO_T5 destroys the live sky box and recreates from the new default", () => {
  const harness = exerciseVariantSwap();

  assert.equal(harness.Cesium.SkyBox.defaultVariant, "TYCHO_T5");
  assert.deepEqual(harness.createCalls, ["TYCHO_T5"]);
  assert.notEqual(harness.scene.skyBox, harness.previousSkyBox);
  assert.deepEqual(harness.destroyedSkyBoxes, [harness.previousSkyBox]);
});

test("HDR plus bloom toggles both exposure surfaces together", () => {
  const harness = createHarness();

  harness.viewModel.hdrBloom = true;
  harness.emit("hdrBloom");
  assert.equal(harness.scene.highDynamicRange, true);
  assert.equal(harness.scene.postProcessStages.bloom.enabled, true);

  harness.viewModel.hdrBloom = false;
  harness.emit("hdrBloom");
  assert.equal(harness.scene.highDynamicRange, false);
  assert.equal(harness.scene.postProcessStages.bloom.enabled, false);
});

test("star-field intensity slider writes the active star field", () => {
  const harness = createHarness();

  harness.viewModel.starFieldIntensity = "2.4";
  harness.emit("starFieldIntensity");

  assert.equal(harness.scene.skyBox.starField.intensity, 2.4);
});

test("none of the three star controls writes clock.shouldAnimate", () => {
  const harness = createHarness();

  harness.viewModel.starMap = "TYCHO_T5";
  harness.emit("starMap");
  harness.viewModel.hdrBloom = true;
  harness.emit("hdrBloom");
  harness.viewModel.starFieldIntensity = "1.8";
  harness.emit("starFieldIntensity");

  assert.equal(harness.clockWrites, 0);
});

test("removing the live-swap destroy call makes the proof go red", () => {
  const destroyStatement = "    previousSkyBox.destroy();\n";
  assert.equal(countOccurrences(CONTROL_WIRING, destroyStatement), 1);

  const mutant = CONTROL_WIRING.replace(destroyStatement, "");
  assert.throws(
    () => exerciseVariantSwap(mutant),
    /previous sky box must be destroyed/,
  );
});
