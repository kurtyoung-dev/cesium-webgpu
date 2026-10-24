// water-demo-behaviour.spec.mjs — the water Sandcastle demo's own behaviour, run from its shipped source.
// @purpose Runs gallery/webgpu-global-water-weather/main.js in a vm against a stub Cesium and a DOM built from its own index.html, and pins what a viewer sees: the foam threshold does not compound, Jerlov returns to the engine default, the depth call uses the public ocean API, labels and counts come from LOCATIONS, and a lighting scenario resets the glint it set. Each pin has an inertness mutant.
// @status ACTIVE
//
// The demo cannot run in Node (it imports "cesium", awaits a WebGPU viewer and reads
// the DOM), so this spec supplies exactly those three things as stubs and executes the
// real main.js text. Nothing here is a copy of the demo's logic: every value asserted
// below was produced by the shipped source.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { applyAnchors, readLf } from "./water-spec-mutants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const GALLERY = path.join(
  ROOT,
  "packages/sandcastle/gallery/webgpu-global-water-weather",
);
const MAIN_JS = readLf(path.join(GALLERY, "main.js"));
const INDEX_HTML = readLf(path.join(GALLERY, "index.html"));

function decodeEntities(text) {
  return text
    .replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.checked = false;
    this.textContent = "";
    this.style = {};
    this.dataset = {};
    this.handlers = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
  }

  addEventListener(type, handler) {
    this.handlers[type] = handler;
  }

  fire(type, target = this) {
    this.handlers[type]({ target });
  }
}

// Elements that carry data-loc in the shipped index.html, in document order.
function locationElementsFromHtml() {
  const out = [];
  for (const match of INDEX_HTML.matchAll(/<(?:button|option)\b([^>]*)>/g)) {
    const attrs = match[1];
    const loc = /data-loc="([^"]*)"/.exec(attrs);
    if (loc === null) {
      continue;
    }
    const el = new FakeElement();
    el.dataset.loc = loc[1];
    el.dataset.name = decodeEntities(/data-name="([^"]*)"/.exec(attrs)[1]);
    out.push(el);
  }
  return out;
}

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

function makeCesium(viewer) {
  return {
    Viewer: { createAsync: async () => viewer },
    Math: {
      toRadians: toRad,
      toDegrees: toDeg,
      clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    },
    Cartesian3: {
      fromDegrees: (lonDeg, latDeg, height) => ({ lonDeg, latDeg, height }),
    },
    Cartographic: {
      fromCartesian: (c) => ({
        longitude: toRad(c.lonDeg),
        latitude: toRad(c.latDeg),
        height: c.height,
      }),
    },
    JulianDate: {
      fromIso8601: (iso) => ({ iso }),
      fromDate: (date) => ({ date }),
    },
  };
}

/**
 * Run `source` (the demo's main.js, possibly mutated) and return what the page exposes.
 */
async function loadDemo(source = MAIN_JS) {
  const log = { primitiveReads: 0, bathymetryCalls: [] };
  const ocean = {
    applyBathymetryTensor(state) {
      log.bathymetryCalls.push({ ...state });
    },
  };
  Object.defineProperty(ocean, "_primitive", {
    get() {
      log.primitiveReads++;
      throw new Error("the demo reached into the private ocean._primitive");
    },
  });
  const globe = {
    oceanFoamThreshold: 0.35,
    oceanDarkening: 0.6,
    water: { ocean },
  };
  const camera = {
    positionCartographic: { height: 2200 },
    setView() {},
    flyTo() {},
    changed: { addEventListener() {} },
  };
  const scene = { globe, camera, requestRender() {} };
  const viewer = { scene, camera, clock: {} };

  const elements = new Map();
  const locationElements = locationElementsFromHtml();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, new FakeElement(id));
      }
      return elements.get(id);
    },
    querySelectorAll(selector) {
      assert.equal(selector, "[data-loc]");
      return locationElements;
    },
  };
  const window = {};
  const code = source.replace(/^import \* as Cesium from "cesium";\n/m, "");
  assert.notEqual(code, source, "the demo must import cesium as a namespace");

  const context = vm.createContext({
    Cesium: makeCesium(viewer),
    document,
    window,
    console,
  });
  await vm.runInContext(`(async () => {\n${code}\n})()`, context, {
    filename: "main.js",
  });
  return {
    globe,
    ocean,
    log,
    window,
    locationElements,
    el: (id) => document.getElementById(id),
  };
}

function setSlider(demo, id, value) {
  const el = demo.el(id);
  el.value = String(value);
  el.fire("input");
}

const checks = {
  async foamDoesNotCompound(source = MAIN_JS) {
    const demo = await loadDemo(source);
    assert.equal(
      demo.globe.oceanFoamThreshold,
      0.35,
      "preset wind keeps the default",
    );
    setSlider(demo, "windSpeed", 9.5);
    const once = demo.globe.oceanFoamThreshold;
    assert.ok(once < 0.35, "stronger wind lowers the foam threshold");
    for (let i = 0; i < 20; i++) {
      setSlider(demo, "windSpeed", 9.5);
    }
    assert.equal(
      demo.globe.oceanFoamThreshold,
      once,
      "twenty more applications at the same wind give the same threshold",
    );
    setSlider(demo, "windSpeed", 8.5);
    assert.equal(
      demo.globe.oceanFoamThreshold,
      0.35,
      "the slider back at the preset restores the engine default",
    );
  },

  async jerlovReturnsToDefault(source = MAIN_JS) {
    const demo = await loadDemo(source);
    assert.equal(demo.globe.oceanDarkening, 0.6);
    const jerlov = demo.el("jerlovType");
    jerlov.value = "5";
    jerlov.fire("change");
    assert.notEqual(
      demo.globe.oceanDarkening,
      0.6,
      "Type 5 darkens differently",
    );
    jerlov.value = "2";
    jerlov.fire("change");
    assert.equal(
      demo.globe.oceanDarkening,
      0.6,
      "Type IB restores the engine default instead of keeping the last value",
    );
  },

  async bathymetryUsesPublicOceanApi(source = MAIN_JS) {
    const demo = await loadDemo(source);
    setSlider(demo, "bathymetryDepth", 120);
    const last = demo.log.bathymetryCalls.at(-1);
    assert.ok(last, "the public ocean.applyBathymetryTensor must be called");
    assert.equal(last.depthMeters, 120);
    assert.equal(last.jerlovType, 2);
    assert.equal(demo.log.primitiveReads, 0, "ocean._primitive is private");
  },

  async labelsComeFromLocations(source = MAIN_JS) {
    const demo = await loadDemo(source);
    const count = Object.keys(demo.window.WATER_LOCATIONS).length;
    assert.ok(count > 6);
    assert.equal(demo.el("siteCount").textContent, String(count));
    const text = (key) =>
      demo.locationElements
        .filter((e) => e.dataset.loc === key)
        .map((e) => e.textContent);
    assert.ok(
      text("orbit").length >= 2,
      "button and option for the orbit regime",
    );
    for (const label of text("orbit")) {
      assert.match(label, /\(450\.0 km\)$/);
    }
    for (const label of text("flight")) {
      assert.match(label, /\(2\.2 km\)$/);
    }
    for (const label of text("atmosphere")) {
      assert.match(label, /\(42\.0 km\)$/);
    }
    for (const label of text("seaLevel")) {
      assert.match(label, /\(14 m\)$/);
    }
    for (const label of text("shallowUnderwater")) {
      assert.match(label, /\(simulated depth 18 m\)$/);
    }
    for (const label of text("deepUnderwater")) {
      assert.match(label, /\(simulated depth 4\.8 km\)$/);
    }
  },

  async lightingScenarioResetsGlint(source = MAIN_JS) {
    const demo = await loadDemo(source);
    demo.window.selectPreset("low");
    assert.equal(
      demo.globe.oceanCelestialReflection,
      false,
      "Low has no glint",
    );
    demo.window.setLightingScenario("moon_night", "bahamas");
    assert.equal(
      demo.globe.oceanCelestialReflection,
      true,
      "moon_night needs it",
    );
    demo.window.setLightingScenario("dawn", "bahamas");
    assert.equal(
      demo.globe.oceanCelestialReflection,
      false,
      "leaving moon_night restores the preset's glint",
    );
  },
};

const MUTANTS = {
  foamDoesNotCompound: [
    [
      "FOAM_THRESHOLD_DEFAULT - windDelta * 0.008",
      "globe.oceanFoamThreshold - windDelta * 0.008",
    ],
  ],
  jerlovReturnsToDefault: [
    [
      "state.jerlovType === 2\n        ? OCEAN_DARKENING_DEFAULT",
      "false && state.jerlovType === 2\n        ? OCEAN_DARKENING_DEFAULT",
    ],
  ],
  bathymetryUsesPublicOceanApi: [
    [
      "      ocean.applyBathymetryTensor({",
      "      ocean._primitive.applyBathymetryTensor({",
    ],
  ],
  labelsComeFromLocations: [
    ["refreshLocationLabels();\n\n// Start", "// Start"],
  ],
  lightingScenarioResetsGlint: [
    [
      'state.celestialGlint = PRESETS[window.currentTier || "medium"].celestialGlint;',
      "",
    ],
  ],
};

for (const [name, check] of Object.entries(checks)) {
  test(`the demo: ${name}`, () => check(MAIN_JS));
  test(`the demo: ${name} goes red when its clause is unreachable (inertness mutant)`, async () => {
    const mutated = applyAnchors(MAIN_JS, MUTANTS[name]);
    assert.notEqual(mutated, MAIN_JS);
    await assert.rejects(
      () => check(mutated),
      (e) => {
        // Name the reason so a harness error cannot pass for an inertness result.
        assert.ok(
          e instanceof assert.AssertionError ||
            /private ocean\._primitive/.test(String(e.message)),
          `${name}: the mutant must fail an assertion, got ${e.message}`,
        );
        return true;
      },
    );
  });
}

test("the gallery entry has no legacyId (the page is new, there is no legacy URL to keep)", () => {
  const yaml = fs.readFileSync(path.join(GALLERY, "sandcastle.yaml"), "utf8");
  assert.doesNotMatch(yaml, /^legacyId:/m);
});
