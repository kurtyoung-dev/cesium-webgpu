// lunar-moonlight-dimming.spec.mjs — the lunar arm of the scene-light contract.
// @purpose Proves moonlight dims by the eclipsed Moon's own disc brightness, that the solar arm stays exactly 1.0 throughout a lunar eclipse, and that the two arms are mutually exclusive by light type on both backends.
// @status ACTIVE
//
// WHAT THIS SPEC IS FOR. `EclipseState` models the Moon crossing the SUN. Its
// scene-light factor is applied only to a `SunLight`, and that gate is the
// whole of what made the module solar-only. This lane amends the contract with
// a second factor for the complementary event — Earth's shadow crossing the
// MOON — applied only to a `MoonLight`.
//
// The failure mode that amendment invites is cross-contamination: the two
// events are both called "eclipse", both live in the same function, and
// swapping them produces something that still runs. Applying the solar factor
// during a lunar eclipse would darken a fully sunlit world for no reason;
// applying the lunar factor during a solar eclipse would do nothing at all.
// So this spec proves the separation with the real ephemeris rather than with
// a regex: it builds the solar state from the geometry of a real lunar eclipse
// and requires the solar factor to be exactly 1.0 at every minute of it.
//
// The dimming quantity is not tuned here. It is the Moon's disc-averaged
// brightness under the same per-point law the two disc shaders evaluate, which
// is what stops the rendered disc and the light it casts from disagreeing.
//
// LINE ENDINGS: this repo checks out CRLF. Every source read below is
// normalised to `\n` first.
//
// Run: node --test Tools/visual-regression/lunar-moonlight-dimming.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(root, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

async function load(relativePath) {
  return await import(pathToFileURL(path.join(root, relativePath)).href);
}

const uniformState = read("packages/engine/Source/Renderer/UniformState.js");
const modelRenderer = read(
  "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts",
);
const eclipseStateSource = read("packages/engine/Source/Scene/EclipseState.js");

const {
  createEclipseState,
  updateEclipseState,
  getEclipseSceneLightFactor,
  getLunarEclipseMoonlightFactor,
} = await load("packages/engine/Source/Scene/EclipseState.js");

const { createLunarEclipseState, updateLunarEclipseState } = await load(
  "packages/engine/Source/Scene/LunarEclipseState.js",
);

const Cartesian3 = (await load("packages/engine/Source/Core/Cartesian3.js"))
  .default;
const CesiumMath = (await load("packages/engine/Source/Core/Math.js")).default;
const Ellipsoid = (await load("packages/engine/Source/Core/Ellipsoid.js"))
  .default;
const JulianDate = (await load("packages/engine/Source/Core/JulianDate.js"))
  .default;
const Simon1994PlanetaryPositions = (
  await load("packages/engine/Source/Core/Simon1994PlanetaryPositions.js")
).default;
const SunLight = (await load("packages/engine/Source/Scene/SunLight.js"))
  .default;
const MoonLight = (await load("packages/engine/Source/Scene/MoonLight.js"))
  .default;

// The 2026-08-28 eclipse, at greatest and at a pre-eclipse reference an hour
// and a half earlier. Both instants are used by the Edge acceptance leg.
const GREATEST = "2026-08-28T04:11:30Z";
const BEFORE_FIRST_CONTACT = "2026-08-28T01:00:00Z";

const lunarState = createLunarEclipseState();
const lunarOptions = {
  sunPositionWC: new Cartesian3(),
  moonPositionWC: new Cartesian3(),
  earthRadius: Ellipsoid.WGS84.maximumRadius,
  moonRadius: CesiumMath.LUNAR_RADIUS,
};

function lunarStateAt(iso) {
  const date = JulianDate.fromIso8601(iso);
  Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
    date,
    lunarOptions.sunPositionWC,
  );
  Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
    date,
    lunarOptions.moonPositionWC,
  );
  return updateLunarEclipseState(lunarState, lunarOptions);
}

// ───────────────────────────────────────────────────────────────────────────
// The amendment itself
// ───────────────────────────────────────────────────────────────────────────

test("moonlight dims by the eclipsed disc's own brightness", () => {
  const atGreatest = lunarStateAt(GREATEST);
  assert.equal(atGreatest.inProgress, true);
  const factor = getLunarEclipseMoonlightFactor(atGreatest, undefined);

  // The factor IS the disc brightness — one law, two consumers. A separately
  // tuned curve here would let the rendered Moon and the light it casts
  // disagree about how eclipsed it is.
  assert.equal(factor, atGreatest.discLuminanceFactor);
  assert.ok(
    factor > 0.04 && factor < 0.05,
    `moonlight factor ${factor} at greatest`,
  );

  // More than an order of magnitude of dimming against the uneclipsed Moon,
  // which is what makes the effect visible at all.
  assert.ok(1.0 / factor > 10.0);
});

test("moonlight is exactly untouched outside the umbral window", () => {
  const before = lunarStateAt(BEFORE_FIRST_CONTACT);
  // Penumbral contact has not happened yet at this instant, so the whole
  // feature is inert.
  assert.equal(before.inProgress, false);
  assert.equal(getLunarEclipseMoonlightFactor(before, undefined), 1.0);

  // A night in the middle of the following lunation: no shadow anywhere near
  // the Moon.
  const ordinary = lunarStateAt("2026-09-15T04:00:00Z");
  assert.equal(ordinary.inProgress, false);
  assert.equal(getLunarEclipseMoonlightFactor(ordinary, undefined), 1.0);
});

test("every degenerate input resolves to the exact identity", () => {
  const atGreatest = lunarStateAt(GREATEST);
  const live = {
    inProgress: true,
    discLuminanceFactor: atGreatest.discLuminanceFactor,
  };
  // Sanity: the harness's own live object does dim, so the cases below are
  // rejections rather than a stub that never dims at all.
  assert.ok(getLunarEclipseMoonlightFactor(live, undefined) < 0.1);

  for (const [label, state] of [
    ["absent", undefined],
    ["null", null],
    ["not in progress", { inProgress: false, discLuminanceFactor: 0.04 }],
    ["missing factor", { inProgress: true }],
    ["non-numeric factor", { inProgress: true, discLuminanceFactor: "0.04" }],
    ["NaN factor", { inProgress: true, discLuminanceFactor: Number.NaN }],
    ["zero factor", { inProgress: true, discLuminanceFactor: 0.0 }],
    ["negative factor", { inProgress: true, discLuminanceFactor: -0.5 }],
    ["above unity", { inProgress: true, discLuminanceFactor: 1.5 }],
  ]) {
    assert.equal(
      getLunarEclipseMoonlightFactor(state, undefined),
      1.0,
      `${label} must resolve to the identity`,
    );
  }

  // The toggle, which is the sensitivity anchor the Edge leg flips.
  assert.equal(
    getLunarEclipseMoonlightFactor(live, { enableLunarEclipse: false }),
    1.0,
  );
  // Absent or true both leave it live — the default is on.
  assert.ok(getLunarEclipseMoonlightFactor(live, {}) < 0.1);
  assert.ok(
    getLunarEclipseMoonlightFactor(live, { enableLunarEclipse: true }) < 0.1,
  );
});

test("the factor tracks the eclipse continuously through its window", () => {
  // Monotone down to greatest and back up, and exactly 1.0 at both ends.
  let minimum = 1.0;
  const start = JulianDate.fromIso8601("2026-08-28T00:00:00Z");
  const samples = [];
  for (let minutes = 0; minutes <= 480; minutes += 5) {
    const date = JulianDate.addMinutes(start, minutes, new JulianDate());
    samples.push({
      minutes,
      factor: getLunarEclipseMoonlightFactor(
        lunarStateAt(JulianDate.toIso8601(date, 0)),
        undefined,
      ),
    });
  }
  assert.equal(samples[0].factor, 1.0, "must be inert before first contact");
  assert.equal(
    samples[samples.length - 1].factor,
    1.0,
    "must return to the identity after last contact",
  );
  let greatestAt = 0;
  for (const sample of samples) {
    assert.ok(sample.factor > 0.0 && sample.factor <= 1.0);
    if (sample.factor < minimum) {
      minimum = sample.factor;
      greatestAt = sample.minutes;
    }
  }
  // The minimum must land on greatest eclipse, not somewhere else.
  assert.ok(
    Math.abs(greatestAt - 251) <= 5,
    `deepest dimming at +${greatestAt} min, expected ~251`,
  );
  // Descending then ascending, with no reversal inside either half.
  for (let i = 1; i < samples.length; i++) {
    const falling = samples[i].minutes <= greatestAt;
    const delta = samples[i].factor - samples[i - 1].factor;
    assert.ok(
      falling ? delta <= 1e-12 : delta >= -1e-12,
      `factor reversed at +${samples[i].minutes} min`,
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// The solar path, proven untouched with the real ephemeris
// ───────────────────────────────────────────────────────────────────────────

test("the solar factor is exactly 1.0 at every minute of a lunar eclipse", () => {
  // The observer is placed at the sub-lunar point of the 2026-08-28 eclipse,
  // where the Moon is at the zenith and the geometry is the most favourable it
  // ever gets for a spurious solar reading.
  const solar = createEclipseState();
  const options = {
    active: true,
    enabled: true,
    autoExposure: false,
    horizonTwilightEnabled: true,
    cameraPositionWC: new Cartesian3(),
    cameraHeight: 0.0,
    sunPositionWC: new Cartesian3(),
    moonPositionWC: new Cartesian3(),
    time: undefined,
    earthOccluderRadius: Ellipsoid.WGS84.maximumRadius,
  };
  const start = JulianDate.fromIso8601("2026-08-28T01:00:00Z");
  let sawTheEclipse = false;
  for (let minutes = 0; minutes <= 360; minutes += 1) {
    const date = JulianDate.addMinutes(start, minutes, new JulianDate());
    options.time = date;
    Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      date,
      options.sunPositionWC,
    );
    Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      date,
      options.moonPositionWC,
    );
    // Stand on the surface directly under the Moon.
    Cartesian3.multiplyByScalar(
      Cartesian3.normalize(options.moonPositionWC, options.cameraPositionWC),
      Ellipsoid.WGS84.maximumRadius,
      options.cameraPositionWC,
    );
    const state = updateEclipseState(solar, options);
    assert.equal(
      state.moonObscuration,
      0.0,
      `the Moon must not be read as occulting the Sun at +${minutes} min`,
    );
    assert.equal(
      getEclipseSceneLightFactor(state),
      1.0,
      `the solar factor moved at +${minutes} min`,
    );
    // The lunar arm, over the same instants, must actually be doing something
    // — otherwise this test proves only that both arms are dead.
    const lunarFactor = getLunarEclipseMoonlightFactor(
      lunarStateAt(JulianDate.toIso8601(date, 0)),
      undefined,
    );
    if (lunarFactor < 0.1) {
      sawTheEclipse = true;
    }
  }
  assert.ok(
    sawTheEclipse,
    "the sweep must cover an interval where the lunar arm is live",
  );
});

test("the two light types are disjoint, so the two arms cannot both fire", () => {
  const sun = new SunLight();
  const moon = new MoonLight();
  assert.ok(sun instanceof SunLight);
  assert.ok(!(sun instanceof MoonLight));
  assert.ok(moon instanceof MoonLight);
  assert.ok(!(moon instanceof SunLight));
});

// ───────────────────────────────────────────────────────────────────────────
// Both consumers, both backends
// ───────────────────────────────────────────────────────────────────────────

test("the contract amendment is stated where the contract is", () => {
  assert.match(
    eclipseStateSource,
    /function getLunarEclipseMoonlightFactor\(state, lighting\)/,
  );
  // The solar function's own documentation must name the lunar arm, so a
  // reader who finds one finds the other.
  const solarDoc = eclipseStateSource.slice(
    eclipseStateSource.lastIndexOf(
      "/**",
      eclipseStateSource.indexOf("function getEclipseSceneLightFactor(state)"),
    ),
    eclipseStateSource.indexOf("function getEclipseSceneLightFactor(state)"),
  );
  assert.match(solarDoc, /SOLAR ONLY/);
  assert.match(solarDoc, /getLunarEclipseMoonlightFactor/);
  assert.match(eclipseStateSource, /getLunarEclipseMoonlightFactor,\n/);
});

test("UniformState applies the lunar arm after the LDR clamp", () => {
  assert.match(
    uniformState,
    /import MoonLight from "\.\.\/Scene\/MoonLight\.js";/,
  );
  assert.match(
    uniformState,
    /import \{ getLunarEclipseMoonlightFactor \} from "\.\.\/Scene\/EclipseState\.js";/,
  );
  assert.match(uniformState, /if \(light instanceof MoonLight\) \{/);
  assert.match(
    uniformState,
    /frameState\.atmosphericConditions\?\.lighting,/,
    "the toggle must reach the resolver",
  );
  assert.match(uniformState, /if \(moonlightFactor !== 1\.0\) \{/);
  // Both channels, exactly as the solar arm does: `_lightColor` is the LDR
  // renormalisation of `_lightColorHdr`, and dimming only one desynchronises
  // the two.
  const armAt = uniformState.indexOf("if (light instanceof MoonLight) {");
  assert.ok(armAt > 0);
  const arm = uniformState.slice(armAt, armAt + 900);
  assert.match(arm, /this\._lightColorHdr,\n\s*moonlightFactor,/);
  assert.match(arm, /this\._lightColor,\n\s*moonlightFactor,/);
  // After the clamp — the same ordering requirement the solar arm carries.
  const clampAt = uniformState.indexOf(
    "Cartesian3.clone(lightColorHdr, this._lightColor);",
  );
  assert.ok(clampAt > 0 && armAt > clampAt, "the arm must follow the clamp");
});

test("the WebGPU model path carries its own copy of the multiply", () => {
  assert.match(
    modelRenderer,
    /import MoonLight from "\.\.\/\.\.\/Scene\/MoonLight\.js";/,
  );
  assert.match(modelRenderer, /if \(light instanceof MoonLight\) \{/);
  assert.match(
    modelRenderer,
    /eclipseFactor = getLunarEclipseMoonlightFactor\(/,
  );
  // The lunar arm must reach the same `data[4..6]` product the solar arm does,
  // which is what keeps WebGPU models in step with the WebGPU globe.
  const armAt = modelRenderer.indexOf("if (light instanceof MoonLight) {");
  const productAt = modelRenderer.indexOf("data[4] = lightColor.red *");
  assert.ok(armAt > 0 && productAt > armAt, "the arm must precede the product");
  // Declared on the frame-state shape so the gate is typed rather than cast.
  assert.match(modelRenderer, /lunarEclipse\?: \{/);
  assert.match(modelRenderer, /discLuminanceFactor\?: number;/);
});

test("PREDICTIONS: the numbers the Edge run is measured against", () => {
  // With `scene.light = new Cesium.MoonLight()` and the eclipse-explorer lunar
  // preset at greatest, the scene light must be dimmed to 4.52% of its
  // pre-eclipse value, on both backends, in the globe shading AND in any
  // WebGPU glTF model in frame. The sensitivity anchor is
  // `atmosphericConditions.lighting.enableLunarEclipse = false`, which must
  // restore the full-Moon lighting exactly.
  const factor = getLunarEclipseMoonlightFactor(
    lunarStateAt(GREATEST),
    undefined,
  );
  assert.ok(Math.abs(factor - 0.04518134) < 1e-6, `factor ${factor}`);
  assert.equal(
    getLunarEclipseMoonlightFactor(
      lunarStateAt(BEFORE_FIRST_CONTACT),
      undefined,
    ),
    1.0,
  );
});
