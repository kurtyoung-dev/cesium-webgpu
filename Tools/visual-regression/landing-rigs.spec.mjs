// landing-rigs.spec.mjs - lane KT. Pure Node: no browser, no GPU.
//
// @purpose Drives the real rig-registry.mjs over the real rigs/ directory and asserts the eight landing-cell rigs load, validate, and say what the landing plan needs of them: the flight camera and dials, the night rig differing from the noon rig by the clock alone, the sky-only rig with clouds off and clock steps, the single-deck 4x MSAA orbital rig, the pinned and HDR default views, the viewer-page horizon twin, the water teardown scene, and (round 5, K5-5) the clock-pinned twins of globe-default and globe-horizon with their clock-pin setup.
// @status ACTIVE
//
// EVERY ASSERTION READS OUTPUT OF THE REAL MODULES. `loadRigs()` dynamically
// imports the actual files under `rigs/`; `validateRig`, `replayKeyFor` and
// `generateScenesJson` are the real functions. Nothing greps rig source text.
// The registry's SIZE is not pinned here (rig-registry.spec.mjs owns the one
// census); this spec asserts the presence and the content of the new rigs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RIG_TAGS,
  generateScenesJson,
  loadRigs,
  replayKeyFor,
  rigById,
  scenesJsonPath,
  validateRig,
} from "./lib/rig-registry.mjs";

const NEW_IDS = Object.freeze([
  "cloud-flight-multideck-hdr-1080p",
  "cloud-underside-night-cov055",
  "sky-only-sun-change",
  "orbital-fulldisc-6608km-msaa4-single-deck",
  "default-3d-pinned",
  "default-3d-hdr",
  "globe-horizon-viewer",
  "water-coast-50km-enhanced-ocean",
]);

const DEG = Math.PI / 180;
const rigs = await loadRigs();
const byId = (id) => {
  const rig = rigById(rigs, id);
  assert.ok(rig, `rig ${id} is not in the registry`);
  return rig;
};

test("R1: every new rig is in the registry, valid, and the water tag exists", () => {
  assert.ok(RIG_TAGS.includes("water"), "RIG_TAGS must admit `water`");
  for (const id of NEW_IDS) {
    const rig = byId(id);
    assert.deepEqual(validateRig(rig), [], `${id} has violations`);
    assert.equal(rigs.filter((r) => r.id === id).length, 1, `${id} duplicated`);
  }
  for (const rig of rigs) {
    assert.deepEqual(validateRig(rig), [], `${rig.id} has violations`);
  }
});

test("R1: each new rig declares clock, readiness, a viewport and a complete-or-null camera", () => {
  for (const id of NEW_IDS) {
    const rig = byId(id);
    assert.equal(typeof rig.clock, "string", `${id} clock`);
    assert.ok(Number.isFinite(Date.parse(rig.clock)), `${id} clock parses`);
    assert.ok(rig.readiness && rig.readiness.frames > 0, `${id} readiness`);
    assert.ok(rig.viewport.width > 0 && rig.viewport.height > 0, `${id} view`);
    assert.ok(rig.description.length > 20, `${id} description`);
    assert.ok(rig.renderers.length > 0, `${id} renderers`);
    if (rig.camera !== null) {
      for (const k of ["lon", "lat", "height", "heading", "pitch", "roll"]) {
        assert.ok(Number.isFinite(rig.camera[k]), `${id} camera.${k}`);
      }
    }
  }
});

test("R2: the night rig differs from the noon rig in the clock alone", () => {
  const noon = byId("cloud-underside-noon-cov055");
  const night = byId("cloud-underside-night-cov055");
  assert.deepEqual(night.camera, noon.camera);
  assert.deepEqual(night.dials, noon.dials);
  assert.deepEqual(night.viewport, noon.viewport);
  assert.deepEqual(night.readiness, noon.readiness);
  assert.notEqual(night.clock, noon.clock);
  // BEHAVIOUR_CELOS R2 says "12 h later"; the rig's instant is 06:20Z on the
  // SAME date as the noon rig's 18:20Z, i.e. 12 h earlier. Either is solar
  // midnight; the spec pins the half-day separation, not its sign.
  assert.equal(
    Math.abs(Date.parse(night.clock) - Date.parse(noon.clock)),
    12 * 3600 * 1000,
    "the night clock is exactly half a day from noon",
  );
  assert.notEqual(replayKeyFor(night), replayKeyFor(noon));
});

test("R3: the E-O rig is the orbital full disc plus exactly two dials", () => {
  const base = byId("orbital-fulldisc-6608km");
  const eo = byId("orbital-fulldisc-6608km-msaa4-single-deck");
  assert.deepEqual(eo.camera, base.camera);
  assert.equal(eo.clock, base.clock);
  assert.deepEqual(eo.viewport, base.viewport);
  assert.deepEqual(eo.readiness, base.readiness);
  assert.deepEqual(eo.disc, base.disc);
  assert.deepEqual(eo.dials, {
    ...base.dials,
    cloudMultiDeck: false,
    msaaSamples: 4,
  });
});

test("R4: the default views are pinned to a clock and differ by HDR alone", () => {
  const pinned = byId("default-3d-pinned");
  const hdr = byId("default-3d-hdr");
  assert.notEqual(pinned.clock, null);
  assert.notEqual(hdr.clock, null);
  assert.equal(pinned.clock, hdr.clock);
  assert.deepEqual(pinned.camera, hdr.camera);
  assert.deepEqual(pinned.viewport, hdr.viewport);
  assert.deepEqual(pinned.readiness, hdr.readiness);
  assert.deepEqual(
    { ...(pinned.dials ?? {}), highDynamicRange: true },
    hdr.dials,
  );
  assert.equal(pinned.dials?.highDynamicRange, undefined);
  for (const rig of [pinned, hdr]) {
    assert.ok(rig.renderers.includes("webgl"), `${rig.id} webgl`);
    assert.ok(rig.renderers.includes("webgpu"), `${rig.id} webgpu`);
  }
});

test("R5: the sky-only rig has clouds off, no cloud dial and later clock steps", () => {
  const rig = byId("sky-only-sun-change");
  assert.equal(rig.dials.cloudsEnabled, false);
  assert.deepEqual(
    Object.keys(rig.dials).filter((k) => /^cloud(?!sEnabled$)[A-Z]/.test(k)),
    [],
  );
  const steps = rig.dials.clockSteps;
  assert.ok(Array.isArray(steps) && steps.length >= 2);
  const start = Date.parse(rig.clock);
  let last = start;
  for (const s of steps) {
    const t = Date.parse(s);
    assert.ok(t > last, `step ${s} is later than the one before it`);
    last = t;
  }
});

test("R6: the flight rig reads the E4 flight cell", () => {
  const rig = byId("cloud-flight-multideck-hdr-1080p");
  assert.equal(rig.camera.lon, -100);
  assert.equal(rig.camera.lat, 40);
  assert.equal(rig.camera.height, 2500);
  assert.equal(rig.camera.heading, 0);
  assert.ok(Math.abs(rig.camera.pitch - -12 * DEG) < 1e-12);
  assert.equal(rig.clock, "2026-06-21T21:40:00Z");
  assert.deepEqual(rig.viewport, { width: 1920, height: 1080 });
  assert.equal(rig.dials.cloudMultiDeck, true);
  assert.equal(rig.dials.highDynamicRange, true);
  assert.equal(rig.dials.msaaSamples, 4);
});

test("the viewer-page horizon twin and the water scene say what the cells need", () => {
  const horizon = byId("globe-horizon-viewer");
  assert.equal(horizon.page, "Apps/CesiumViewer/index.html");
  assert.equal(horizon.camera.height, 80000);
  assert.notEqual(horizon.clock, null);
  const water = byId("water-coast-50km-enhanced-ocean");
  assert.deepEqual(water.tags, ["water"]);
  assert.equal(water.dials.enableEnhancedOcean, true);
  assert.equal(water.dials.waterQualityPreset, "HIGH");
  assert.deepEqual(water.dials.tierSwitch.values, ["LOW", "HIGH"]);
  assert.ok(water.dials.resizeLadder.length >= 2);
});

test("new rig keys are distinct from each other", () => {
  const keys = new Set(NEW_IDS.map((id) => replayKeyFor(byId(id))));
  assert.equal(keys.size, NEW_IDS.length);
});

test("R7: scenes.json is still reproduced byte for byte", () => {
  assert.equal(
    generateScenesJson(rigs),
    readFileSync(scenesJsonPath(), "utf8"),
  );
});

// ---------------------------------------------------------------------------
// Round 2 (after Ettenmoors pass 1): the rigs pinned against their SOURCES,
// not against themselves. The expected values below are transcribed from the
// source each rig claims, never from the rig file: the banked E4 driver
// (`e4-driver.mjs`, sha256 b01c1140...fafecd, `CELLS.flight` and
// `ASTRA_CLOUD`, whose `cloudType: "CUMULUS"` the driver resolved to
// `CloudType.CUMULUS`, 0) and the water lane's job sheet (`EDGE_LEG_WATER.md`
// leg 2, row `water-coast-50km`, clock 2026-06-21T16:00:00Z with `pinClock`).
// ---------------------------------------------------------------------------

/** The E4 driver's flight cell as dials (its page had no terrain: ellipsoid). */
const E4_FLIGHT_DIALS = Object.freeze({
  cloudType: 0,
  cloudCoverage: 0.6,
  cloudDensity: 0.35,
  cloudLayerBottom: 1500,
  cloudLayerTop: 4000,
  cloudWindSpeed: 0,
  cloudVolumetricQuality: "high",
  cloudWeatherMap: false,
  cloudAerialMode: "physical",
  cloudAmbientSource: "sky-lut",
  cloudMultiDeck: true,
  highDynamicRange: true,
  msaaSamples: 4,
  globeEnableLighting: true,
  skyAtmosphereMultipleScattering: true,
  imagery: "naturalEarth",
  terrain: "ellipsoid",
});

test("R6b: the flight rig carries the E4 flight cell's full dial set and nothing else", () => {
  const rig = byId("cloud-flight-multideck-hdr-1080p");
  assert.deepEqual({ ...rig.dials }, { ...E4_FLIGHT_DIALS });
});

test("R8: the water rig is the EDGE_LEG_WATER.md water-coast-50km row plus the enhanced ocean", () => {
  const rig = byId("water-coast-50km-enhanced-ocean");
  assert.deepEqual(
    { ...rig.camera },
    {
      lon: -122.45,
      lat: 37.75,
      height: 50000,
      heading: 0,
      pitch: -1.2,
      roll: 0,
    },
  );
  assert.equal(rig.clock, "2026-06-21T16:00:00Z");
  assert.deepEqual({ ...rig.viewport }, { width: 1280, height: 720 });
  assert.equal(rig.dials.terrain, "ellipsoid");
  assert.equal(rig.dials.globalWaterMask, true);
  assert.equal(rig.dials.pinClock, true);
  assert.deepEqual(rig.renderers, ["webgl", "webgpu"]);
});

test("R5b: the sky-only rig shows the sky box, the sky atmosphere and the sun", () => {
  const rig = byId("sky-only-sun-change");
  assert.equal(rig.dials.skyBoxShow, true);
  assert.equal(rig.dials.skyAtmosphereShow, true);
  assert.equal(rig.dials.sunShow, true);
});

test("R4b: default-3d-pinned is default-3d with only the clock pinned", () => {
  const strip = (rig) => {
    const copy = JSON.parse(JSON.stringify(rig));
    for (const key of ["id", "description", "declaredBy", "clock"]) {
      delete copy[key];
    }
    return copy;
  };
  assert.deepEqual(strip(byId("default-3d-pinned")), strip(byId("default-3d")));
  assert.equal(byId("default-3d").clock, null);
});

test("R4c: the 2D and Columbus identity rigs are default-3d-pinned with only the scene mode dial", () => {
  const strip = (rig) => {
    const copy = JSON.parse(JSON.stringify(rig));
    for (const key of ["id", "description", "declaredBy", "dials"]) {
      delete copy[key];
    }
    return copy;
  };
  const base = byId("default-3d-pinned");
  assert.equal(base.dials, undefined, "the 3D rig carries no dials");
  for (const [id, mode] of [
    ["default-2d-pinned", "SCENE2D"],
    ["default-columbus-pinned", "COLUMBUS_VIEW"],
  ]) {
    const rig = byId(id);
    assert.deepEqual(validateRig(rig), [], `${id} has violations`);
    assert.equal(rigs.filter((r) => r.id === id).length, 1, `${id} duplicated`);
    assert.deepEqual(rig.dials, { sceneMode: mode }, `${id} dials`);
    assert.deepEqual(strip(rig), strip(base), `${id} differs beyond the mode`);
    assert.equal(rig.camera, null, `${id} uses the mode's own default view`);
    assert.notEqual(rig.description, base.description);
    assert.notEqual(rig.declaredBy, base.declaredBy);
  }
  assert.notEqual(
    replayKeyFor(byId("default-2d-pinned")),
    replayKeyFor(byId("default-columbus-pinned")),
    "the two modes are different replays",
  );
  assert.notEqual(replayKeyFor(byId("default-2d-pinned")), replayKeyFor(base));
});

// ---------------------------------------------------------------------------
// R9 (ROUND 5, K5-5): the clock-pinned twins of globe-default and
// globe-horizon. Lead addition (Celos, round 5), written from the seat's item
// text and the accepted baseline manifest, not from the rig files.
// ---------------------------------------------------------------------------

const TWINS = Object.freeze({
  "globe-default-clock-pinned": "globe-default",
  "globe-horizon-clock-pinned": "globe-horizon",
});

// The fields a twin may differ from its original in.
const TWIN_FIELDS = Object.freeze([
  "id",
  "description",
  "declaredBy",
  "tags",
  "clock",
  "setupFile",
  "setupParams",
  "legacyOrder",
  "legacyExtraOrder",
]);

test("R9: each twin is its original with the clock pinned through the clock-pin setup, and nothing else", () => {
  for (const [twinId, originalId] of Object.entries(TWINS)) {
    const twin = byId(twinId);
    const original = byId(originalId);
    assert.deepEqual(validateRig(twin), []);
    const strip = (rig) => {
      const copy = JSON.parse(JSON.stringify(rig));
      for (const key of TWIN_FIELDS) {
        delete copy[key];
      }
      return copy;
    };
    assert.deepEqual(strip(twin), strip(original), twinId);
    assert.equal(original.clock, null, `${originalId} follows the wall clock`);
    assert.equal(typeof twin.clock, "string");
    assert.deepEqual(twin.setupParams, { pinnedTimeIso: twin.clock });
    assert.equal(twin.setupFile, "scenes/clock-pin-setup.js");
    assert.deepEqual(twin.legacyExtraOrder, ["setupFile", "setupParams"]);
    // Held out of scenes.json until its baselines exist.
    assert.ok(!twin.tags.includes("wave-end"), `${twinId} is not wave-end`);
    assert.ok(twin.tags.includes("globe"));
    assert.ok(original.tags.includes("wave-end"));
  }
});

test("R9: the globe-default twin's instant is the capturedAt its accepted baselines record", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("./baseline/manifest.json", import.meta.url), "utf8"),
  );
  for (const renderer of ["webgl", "webgpu"]) {
    const entry = manifest.entries[`globe-default:${renderer}`];
    assert.ok(entry, `globe-default:${renderer} is in the manifest`);
    assert.equal(
      `${entry.capturedAt.slice(0, 19)}Z`,
      byId("globe-default-clock-pinned").clock,
      `the ${renderer} baseline's capturedAt, to the second`,
    );
  }
});

test("R9: the globe-horizon twin's instant is local solar noon at its camera, on the same date", () => {
  const twin = byId("globe-horizon-clock-pinned");
  const at = new Date(twin.clock);
  const utcHours = at.getUTCHours() + at.getUTCMinutes() / 60;
  const noon = 12 - twin.camera.lon / 15;
  assert.ok(
    Math.abs(utcHours - noon) < 1 / 60,
    `${twin.clock} is within a minute of ${noon} h UTC`,
  );
  assert.equal(
    twin.clock.slice(0, 10),
    byId("globe-default-clock-pinned").clock.slice(0, 10),
  );
});

test("R9: tagging the twins wave-end adds exactly their two entries to scenes.json, each right after its original", () => {
  const promoted = rigs.map((rig) =>
    Object.hasOwn(TWINS, rig.id)
      ? { ...rig, tags: [...rig.tags, "wave-end"] }
      : rig,
  );
  const live = JSON.parse(readFileSync(scenesJsonPath(), "utf8"));
  const next = JSON.parse(generateScenesJson(promoted));
  const names = next.scenes.map((scene) => scene.name);
  for (const [twinId, originalId] of Object.entries(TWINS)) {
    assert.equal(names.indexOf(twinId), names.indexOf(originalId) + 1);
    const entry = next.scenes.find((scene) => scene.name === twinId);
    assert.equal(entry.setupFile, "scenes/clock-pin-setup.js");
    assert.deepEqual(entry.setupParams, {
      pinnedTimeIso: byId(twinId).clock,
    });
  }
  assert.deepEqual(
    {
      ...next,
      scenes: next.scenes.filter((scene) => !Object.hasOwn(TWINS, scene.name)),
    },
    live,
    "every other entry and field is unchanged",
  );
});

// The setup file, run the way capture-and-diff's applyScene runs it
// (`new Function("params", src)(params)`), against a fake split-screen page.
const CLOCK_PIN_SETUP = readFileSync(
  new URL("./scenes/clock-pin-setup.js", import.meta.url),
  "utf8",
);

function clockPage({ holds = true } = {}) {
  class JulianDate {
    constructor(seconds) {
      this.s = seconds;
    }
    static fromIso8601(text) {
      return new JulianDate(Date.parse(text) / 1000);
    }
    static clone(date) {
      return new JulianDate(date.s);
    }
    static equals(a, b) {
      return !!a && !!b && a.s === b.s;
    }
  }
  const viewer = (shouldAnimate) => {
    const clock = { shouldAnimate, _time: new JulianDate(0) };
    Object.defineProperty(clock, "currentTime", {
      get() {
        return this._time;
      },
      set(value) {
        // A page whose clock ignores the assignment (the negative control).
        if (holds) {
          this._time = value;
        }
      },
    });
    return { clock, scene: { requestRender() {} } };
  };
  return {
    Cesium: { JulianDate },
    webglViewer: viewer(true),
    webgpuViewer: viewer(false),
  };
}

async function runClockPin(page, params) {
  const previous = globalThis.window;
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.window = page;
  globalThis.requestAnimationFrame = (callback) => setImmediate(callback);
  try {
    // eslint-disable-next-line no-new-func
    return await new Function("params", CLOCK_PIN_SETUP)(params);
  } finally {
    globalThis.window = previous;
    globalThis.requestAnimationFrame = previousRaf;
  }
}

test("R9: the clock-pin setup freezes both viewers at the twin's instant", async () => {
  const page = clockPage();
  const twin = byId("globe-horizon-clock-pinned");
  await runClockPin(page, twin.setupParams);
  for (const viewer of [page.webglViewer, page.webgpuViewer]) {
    assert.equal(viewer.clock.shouldAnimate, false);
    assert.equal(viewer.clock.currentTime.s, Date.parse(twin.clock) / 1000);
  }
});

test("R9: the clock-pin setup fails loudly when the clock does not hold or no instant is given", async () => {
  await assert.rejects(
    runClockPin(clockPage({ holds: false }), {
      pinnedTimeIso: "2026-07-18T20:10:00Z",
    }),
    /did not hold 2026-07-18T20:10:00Z/,
  );
  await assert.rejects(
    async () => runClockPin(clockPage(), {}),
    /pinnedTimeIso is required/,
  );
});
