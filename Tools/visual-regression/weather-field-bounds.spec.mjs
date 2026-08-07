// C13-08 — WeatherField bounds / no-data / regional-packer contract.
//
// Pins the decisions this row owns, all of which live in ONE module
// (`Scene/Weather/WeatherFieldGrid.ts`):
//
//   1. the source-grid COORDINATE REFERENCE (node-centred by default, cell-centred
//      when declared) that C13-07 deferred here;
//   2. regional `WeatherField.bounds` are HONOURED — the field lands on its true
//      lat/lon rectangle of the global weather texture, including a rectangle that
//      straddles the antimeridian — instead of being stretched over the planet;
//   3. NO-DATA semantics — outside the bounds, and declared gaps inside them, are
//      written from an explicit fill and never masquerade as an observation;
//   4. the global/procedural path is BYTE-IDENTICAL to the pre-C13-08 packer.
//
// Claim 4 is pinned against a LEGACY ORACLE: `legacyPackWeatherField` below is the
// pre-C13-08 packer transcribed verbatim (it is also the defect oracle for claim 2
// — the same function demonstrably stretches a regional field over the planet).
//
// RUNNER REQUIREMENT: Node >= 22.18 (this spec imports `.ts` modules and relies on
// Node's built-in type stripping).
//   node --test Tools/visual-regression/weather-field-bounds.spec.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();
const {
  DEFAULT_WEATHER_GRID_REGISTRATION,
  PROCEDURAL_NO_DATA_FILL,
  isGlobalWeatherWindow,
  isWeatherSampleObserved,
  weatherFieldGridCoordinate,
  weatherFieldLatSpan,
  weatherFieldLonSpan,
  weatherFieldU,
  weatherFieldV,
  weatherFieldWrapsLongitude,
} =
  await import("../../packages/engine/Source/Scene/Weather/WeatherFieldGrid.ts");
const { packWeatherField, packWeatherFieldDetailed } =
  await import("../../packages/engine/Source/Scene/Weather/WeatherTexPacker.ts");
const { buildProceduralWeatherMap } =
  await import("../../packages/engine/Source/Scene/Weather/ProceduralWeatherMap.ts");
const { applyEquirectPolarLowPass, polarLowPassWidth } =
  await import("../../packages/engine/Source/Scene/Weather/WeatherMapSeam.ts");
const { GLOBAL_WEATHER_BOUNDS } =
  await import("../../packages/engine/Source/Scene/Weather/WeatherTypes.ts");
const { parseCoverageJson } =
  await import("../../packages/engine/Source/Scene/Weather/CoverageJsonParser.ts");
const { MetarWeatherSource } =
  await import("../../packages/engine/Source/Scene/Weather/MetarWeatherSource.ts");
const { SyntheticWeatherSource } =
  await import("../../packages/engine/Source/Scene/Weather/SyntheticWeatherSource.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const readEngine = (relative) =>
  fs.readFileSync(path.join(root, "packages/engine/Source", relative), "utf8");
const gridSource = readEngine("Scene/Weather/WeatherFieldGrid.ts");
const seamSource = readEngine("Scene/Weather/WeatherMapSeam.ts");
const rendererSource = readEngine(
  "Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);

// Must match WEATHER_TEX_W / WEATHER_TEX_H in the renderer.
const TEX_W = 256;
const TEX_H = 128;
const DEG = Math.PI / 180;

// ─────────────────────────────────────────────────────────────────────────────
// The legacy oracle: the pre-C13-08 packer, transcribed verbatim.
// ─────────────────────────────────────────────────────────────────────────────

const CLOUD_BASE_NORM_METERS = 12000.0;
const legacyClamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function legacyBilinear(data, w, h, fx, fy) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = data[y0 * w + x0];
  const b = data[y0 * w + x1];
  const c = data[y1 * w + x0];
  const d = data[y1 * w + x1];
  return (
    a * (1 - tx) * (1 - ty) +
    b * tx * (1 - ty) +
    c * (1 - tx) * ty +
    d * tx * ty
  );
}

/** The pre-C13-08 packer. It ignores `bounds` entirely — that is the defect. */
function legacyPackWeatherField(field, texW = TEX_W, texH = TEX_H) {
  const out = new Uint8Array(texW * texH * 4);
  const gw = field.gridWidth;
  const gh = field.gridHeight;
  const hasType = field.type !== undefined && field.type.length === gw * gh;
  const hasBase =
    field.baseMeters !== undefined && field.baseMeters.length === gw * gh;
  const hasDensity =
    field.densityBias !== undefined && field.densityBias.length === gw * gh;
  for (let ty = 0; ty < texH; ty++) {
    const fy = ((ty + 0.5) / texH) * (gh - 1);
    for (let tx = 0; tx < texW; tx++) {
      const fx = ((tx + 0.5) / texW) * (gw - 1);
      const i = (ty * texW + tx) * 4;
      out[i] = Math.round(
        legacyClamp01(legacyBilinear(field.coverage, gw, gh, fx, fy)) * 255,
      );
      out[i + 1] = hasType
        ? Math.round(
            legacyClamp01(legacyBilinear(field.type, gw, gh, fx, fy) / 10.0) *
              255,
          )
        : 128;
      out[i + 2] = hasBase
        ? Math.round(
            legacyClamp01(
              legacyBilinear(field.baseMeters, gw, gh, fx, fy) /
                CLOUD_BASE_NORM_METERS,
            ) * 255,
          )
        : 0;
      out[i + 3] = hasDensity
        ? Math.round(
            legacyClamp01(legacyBilinear(field.densityBias, gw, gh, fx, fy)) *
              255,
          )
        : 128;
    }
  }
  return applyEquirectPolarLowPass(out, texW, texH);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function globalBounds() {
  return { ...GLOBAL_WEATHER_BOUNDS };
}

/** A west(0) -> east(1) linear ramp: the stored byte reveals the sample position. */
function rampField(bounds = globalBounds(), gridWidth = 64, gridHeight = 32) {
  const coverage = new Float32Array(gridWidth * gridHeight);
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      coverage[y * gridWidth + x] = gridWidth > 1 ? x / (gridWidth - 1) : 0;
    }
  }
  return { gridWidth, gridHeight, coverage, bounds };
}

/** All four channels populated with independent patterns. */
function richField(bounds = globalBounds(), gridWidth = 48, gridHeight = 24) {
  const n = gridWidth * gridHeight;
  const coverage = new Float32Array(n);
  const type = new Float32Array(n);
  const baseMeters = new Float32Array(n);
  const densityBias = new Float32Array(n);
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const i = y * gridWidth + x;
      coverage[i] = ((x * 7 + y * 13) % 97) / 96;
      type[i] = (x + y) % 11;
      baseMeters[i] = ((y * 5 + x) % 61) * 180;
      densityBias[i] = ((x * 3 + y * 11) % 53) / 52;
    }
  }
  return {
    gridWidth,
    gridHeight,
    coverage,
    type,
    baseMeters,
    densityBias,
    bounds,
  };
}

function channelAt(bytes, tx, ty, channel, texW = TEX_W) {
  return bytes[(ty * texW + tx) * 4 + channel];
}

/** Texel column whose CENTRE is nearest `lonDeg`. */
function texelXForLon(lonDeg) {
  const u = (lonDeg * DEG + Math.PI) / (2 * Math.PI);
  return Math.min(TEX_W - 1, Math.max(0, Math.round(u * TEX_W - 0.5)));
}

/** Texel row whose CENTRE is nearest `latDeg`. */
function texelYForLat(latDeg) {
  const v = 1 - (latDeg * DEG + Math.PI / 2) / Math.PI;
  return Math.min(TEX_H - 1, Math.max(0, Math.round(v * TEX_H - 0.5)));
}

/** Rows the polar low-pass leaves byte-identical — where placement is readable. */
function isIdentityRow(ty) {
  return polarLowPassWidth(ty, TEX_H, TEX_W) === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The convention (DECISION 1) is pinned, documented, and lives in one place
// ─────────────────────────────────────────────────────────────────────────────

test("the default source-grid coordinate reference is NODE-centred", () => {
  assert.equal(DEFAULT_WEATHER_GRID_REGISTRATION, "node");
  // node: s=0 -> sample 0, s=1 -> sample count-1 (samples sit ON the bounds).
  assert.equal(weatherFieldGridCoordinate(0, 64, "node"), 0);
  assert.equal(weatherFieldGridCoordinate(1, 64, "node"), 63);
  assert.equal(weatherFieldGridCoordinate(0.5, 65, "node"), 32);
  // cell: s=0 -> half a cell OUTSIDE sample 0 (the outer edge).
  assert.equal(weatherFieldGridCoordinate(0, 64, "cell"), -0.5);
  assert.equal(weatherFieldGridCoordinate(1, 64, "cell"), 63.5);
  assert.equal(weatherFieldGridCoordinate(0.5, 64, "cell"), 31.5);
  // Degenerate axis: one sample covers the window under either registration.
  assert.equal(weatherFieldGridCoordinate(0.7, 1, "node"), 0);
  assert.equal(weatherFieldGridCoordinate(0.7, 1, "cell"), 0);
  // The two registrations differ by exactly half a cell everywhere.
  for (const s of [0, 0.1, 0.37, 0.5, 0.99, 1]) {
    const count = 40;
    const node = weatherFieldGridCoordinate(s, count, "node");
    const cell = weatherFieldGridCoordinate(s, count, "cell");
    assert.ok(
      Math.abs(cell - node - (s * count - 0.5 - s * (count - 1))) < 1e-12,
    );
  }
});

test("the decision is DOCUMENTED in exactly one module, and the seam module defers to it", () => {
  assert.ok(
    /DECISION 1 — the source-grid coordinate reference is NODE-CENTRED by default/.test(
      gridSource,
    ),
    "WeatherFieldGrid must state the coordinate-reference decision",
  );
  assert.ok(
    /DECISION 2 — no-data is NOT an observation of clear sky/.test(gridSource),
    "WeatherFieldGrid must state the no-data decision",
  );
  assert.ok(
    /WeatherFieldGrid/.test(seamSource),
    "WeatherMapSeam (which deferred the decision) must point at the module that made it",
  );
  // Nothing else may re-declare the registration vocabulary.
  const owners = fs
    .readdirSync(path.join(root, "packages/engine/Source/Scene/Weather"))
    .filter((f) => f.endsWith(".ts"))
    .filter((f) =>
      /export\s+type\s+WeatherGridRegistration/.test(
        readEngine(`Scene/Weather/${f}`),
      ),
    );
  assert.deepEqual(owners, ["WeatherFieldGrid.ts"]);
});

test("longitude span is antimeridian-aware; latitude span is not", () => {
  assert.equal(weatherFieldLonSpan(globalBounds()), 2 * Math.PI);
  assert.equal(weatherFieldLatSpan(globalBounds()), Math.PI);
  // A rectangle that straddles +-180 reports its true width, not a negative one.
  const straddle = {
    west: 170 * DEG,
    east: -170 * DEG,
    south: 0,
    north: 10 * DEG,
  };
  assert.ok(Math.abs(weatherFieldLonSpan(straddle) - 20 * DEG) < 1e-12);
  // ...and the same window expressed with an unwrapped east reads identically.
  const unwrapped = { ...straddle, east: 190 * DEG };
  assert.ok(
    Math.abs(weatherFieldLonSpan(unwrapped) - weatherFieldLonSpan(straddle)) <
      1e-12,
  );
  // A zero-width or >=2PI window means "all longitudes" (the legacy global case).
  assert.equal(
    weatherFieldLonSpan({ west: 1, east: 1, south: 0, north: 1 }),
    2 * Math.PI,
  );
  assert.equal(
    weatherFieldLonSpan({ west: -4, east: 4, south: 0, north: 1 }),
    2 * Math.PI,
  );
  // A degenerate latitude window means "all latitudes".
  assert.equal(
    weatherFieldLatSpan({ west: 0, east: 1, south: 0.3, north: 0.3 }),
    Math.PI,
  );
});

test("wrap-awareness engages exactly where it is REACHABLE", () => {
  // Node + full circle: first and last column are the same meridian, so the
  // out-of-range tap is only ever reached with weight zero — no wrap.
  assert.equal(weatherFieldWrapsLongitude(globalBounds(), "node"), false);
  // Cell + full circle: the coordinate range is [-0.5, count-0.5] — reachable.
  assert.equal(weatherFieldWrapsLongitude(globalBounds(), "cell"), true);
  // Regional: there is no data beyond the edge to wrap TO.
  const regional = { west: -2, east: -1, south: 0, north: 0.5 };
  assert.equal(weatherFieldWrapsLongitude(regional, "node"), false);
  assert.equal(weatherFieldWrapsLongitude(regional, "cell"), false);
});

test("the global window maps texel UV to field UV as the IDENTITY (bit-exact)", () => {
  // Not a convenience: routing the global case through radians and back would
  // perturb the last bit and can flip a rounded byte.
  assert.ok(isGlobalWeatherWindow(globalBounds()));
  for (let tx = 0; tx < TEX_W; tx++) {
    const u = (tx + 0.5) / TEX_W;
    assert.equal(weatherFieldU(u, globalBounds()), u, `u drift at tx=${tx}`);
  }
  for (let ty = 0; ty < TEX_H; ty++) {
    const v = (ty + 0.5) / TEX_H;
    assert.equal(weatherFieldV(v, globalBounds()), v, `v drift at ty=${ty}`);
  }
});

test("a regional window maps texel UV onto [0,1] over its own rectangle", () => {
  const bounds = {
    west: -125 * DEG,
    east: -66 * DEG,
    south: 24 * DEG,
    north: 50 * DEG,
  };
  const uOf = (lonDeg) =>
    weatherFieldU((lonDeg * DEG + Math.PI) / (2 * Math.PI), bounds);
  const vOf = (latDeg) =>
    weatherFieldV(1 - (latDeg * DEG + Math.PI / 2) / Math.PI, bounds);
  assert.ok(Math.abs(uOf(-125)) < 1e-12);
  assert.ok(Math.abs(uOf(-66) - 1) < 1e-12);
  assert.ok(Math.abs(uOf(-95.5) - 0.5) < 1e-12);
  assert.ok(uOf(-60) > 1, "east of the rectangle must fall outside [0,1]");
  assert.ok(uOf(-130) > 1, "west of the rectangle must fall outside [0,1]");
  assert.ok(Math.abs(vOf(50)) < 1e-12);
  assert.ok(Math.abs(vOf(24) - 1) < 1e-12);
  assert.ok(vOf(60) < 0 && vOf(10) > 1);
});

test("an antimeridian-straddling window is ONE contiguous [0,1] interval", () => {
  const bounds = {
    west: 170 * DEG,
    east: -170 * DEG,
    south: -5 * DEG,
    north: 5 * DEG,
  };
  const uOf = (lonDeg) =>
    weatherFieldU((lonDeg * DEG + Math.PI) / (2 * Math.PI), bounds);
  assert.ok(Math.abs(uOf(170)) < 1e-9);
  assert.ok(Math.abs(uOf(175) - 0.25) < 1e-9);
  assert.ok(Math.abs(uOf(180) - 0.5) < 1e-9);
  assert.ok(Math.abs(uOf(-175) - 0.75) < 1e-9);
  assert.ok(Math.abs(uOf(-170) - 1) < 1e-9);
  // Monotone across the seam — the interval does not split into two pieces.
  let previous = -Infinity;
  for (let lon = 170; lon <= 190; lon += 0.5) {
    const wrapped = lon > 180 ? lon - 360 : lon;
    const u = uOf(wrapped);
    assert.ok(u >= previous - 1e-9, `not monotone at lon=${lon}`);
    previous = u;
  }
  // ...and everything outside is outside.
  for (const lon of [0, -90, 90, 160, 169.9, -169.9, -100]) {
    assert.ok(uOf(lon) > 1 || uOf(lon) < 0, `lon ${lon} should be outside`);
  }
});

test("no-data classification: NaN always, plus an optional declared sentinel", () => {
  assert.equal(
    isWeatherSampleObserved(0, undefined),
    true,
    "0 IS an observation",
  );
  assert.equal(isWeatherSampleObserved(0.5, undefined), true);
  assert.equal(isWeatherSampleObserved(NaN, undefined), false);
  assert.equal(isWeatherSampleObserved(Infinity, undefined), false);
  assert.equal(isWeatherSampleObserved(-9999, undefined), true);
  assert.equal(isWeatherSampleObserved(-9999, -9999), false);
  assert.equal(isWeatherSampleObserved(0, -9999), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The global / procedural path is byte-identical (feature preservation)
// ─────────────────────────────────────────────────────────────────────────────

test("a GLOBAL field packs to the pre-C13-08 bytes, EXACTLY", () => {
  for (const [name, field] of [
    ["ramp", rampField()],
    ["rich", richField()],
    [
      "uniform",
      {
        gridWidth: 32,
        gridHeight: 16,
        coverage: new Float32Array(32 * 16).fill(0.8),
        bounds: globalBounds(),
      },
    ],
    [
      "coarse",
      {
        gridWidth: 3,
        gridHeight: 2,
        coverage: Float32Array.from([0.1, 0.9, 0.4, 0.7, 0.2, 0.55]),
        bounds: globalBounds(),
      },
    ],
  ]) {
    const now = packWeatherField(field, TEX_W, TEX_H);
    const before = legacyPackWeatherField(field, TEX_W, TEX_H);
    assert.equal(now.length, before.length);
    for (let i = 0; i < now.length; i++) {
      assert.equal(
        now[i],
        before[i],
        `${name}: byte ${i} changed (${before[i]} -> ${now[i]})`,
      );
    }
  }
});

test("a global field fills NOTHING and reports itself as global", () => {
  const result = packWeatherFieldDetailed(rampField(), TEX_W, TEX_H);
  assert.equal(result.global, true);
  assert.equal(result.registration, "node");
  assert.equal(result.fillKind, "procedural");
  assert.equal(result.filledTexels, 0);
  assert.equal(result.observedTexels, TEX_W * TEX_H);
});

test("PROCEDURAL_NO_DATA_FILL is the default and the procedural producer is untouched", () => {
  assert.deepEqual(PROCEDURAL_NO_DATA_FILL, { kind: "procedural" });
  // The renderer's no-provider bytes must be exactly what a fully-unobserved
  // field packs to (modulo the polar low-pass, which is idempotent on the cap
  // rows because a constant row's mean is that constant).
  const empty = {
    gridWidth: 4,
    gridHeight: 4,
    coverage: new Float32Array(16).fill(NaN),
    bounds: globalBounds(),
  };
  const packed = packWeatherFieldDetailed(empty, TEX_W, TEX_H);
  assert.equal(packed.observedTexels, 0);
  assert.equal(packed.filledTexels, TEX_W * TEX_H);
  const procedural = buildProceduralWeatherMap(TEX_W, TEX_H);
  for (let ty = 0; ty < TEX_H; ty++) {
    for (let tx = 0; tx < TEX_W; tx++) {
      for (let channel = 0; channel < 4; channel++) {
        assert.equal(
          channelAt(packed.bytes, tx, ty, channel),
          channelAt(procedural, tx, ty, channel),
          `all-no-data fill differs from the procedural map at ${tx},${ty},${channel}`,
        );
      }
    }
  }
});

// The row loop above used to `continue` past every non-identity row, with the
// note "the composite is low-passed once more in the polar band" — i.e. the
// spec routed around the divergence while the module JSDoc kept promising "the
// same bytes the renderer already shows when there is no provider at all",
// unqualified. It IS the same bytes now, on every row. These three tests hold
// the fix from all three sides: the byte-identity, the mechanism that broke it,
// and the pole safety that must survive the repair.

test("the procedural fill is not low-passed a SECOND time", () => {
  const empty = {
    gridWidth: 4,
    gridHeight: 4,
    coverage: new Float32Array(16).fill(NaN),
    bounds: globalBounds(),
  };
  const packed = packWeatherFieldDetailed(empty, TEX_W, TEX_H);
  const procedural = buildProceduralWeatherMap(TEX_W, TEX_H);

  // The defect oracle: what the packer produced before the restore pass is
  // exactly the reference map run through the filter a second time.
  const doubleFiltered = applyEquirectPolarLowPass(
    Uint8Array.from(procedural),
    TEX_W,
    TEX_H,
  );
  let doubleFilterDiffs = 0;
  let worstDelta = 0;
  const affectedRows = new Set();
  for (let i = 0; i < procedural.length; i++) {
    const delta = Math.abs(doubleFiltered[i] - procedural[i]);
    if (delta !== 0) {
      doubleFilterDiffs++;
      worstDelta = Math.max(worstDelta, delta);
      affectedRows.add(Math.floor(i / (TEX_W * 4)));
    }
  }
  // The mutation must be able to fail: a second filter really does move bytes,
  // so a passing byte-identity below is not vacuous.
  assert.ok(
    doubleFilterDiffs > 1000,
    `a second low-pass must actually move bytes, moved ${doubleFilterDiffs}`,
  );
  assert.ok(worstDelta >= 8, `worst byte delta ${worstDelta}`);
  // ...and only OUTSIDE the polar caps, which are idempotent (a constant row's
  // mean is that constant) — that is why the cap exemption in the restore pass
  // costs nothing here.
  assert.ok(!affectedRows.has(0) && !affectedRows.has(TEX_H - 1));

  // The shipped bytes are the SINGLE-filtered reference, not the double.
  assert.deepEqual(Array.from(packed.bytes), Array.from(procedural));
  assert.notDeepEqual(Array.from(packed.bytes), Array.from(doubleFiltered));
});

test("a PARTIAL provider keeps the unobserved texels byte-identical to the no-provider map", () => {
  // The shape the METAR source actually produces: observed in one longitude
  // half, no-data everywhere else. Every unobserved texel outside the polar
  // caps must still be the no-provider byte, or attaching the provider visibly
  // re-blurs the sky where nothing was measured.
  const gw = 8;
  const gh = 8;
  const coverage = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      coverage[y * gw + x] = x < gw / 2 ? 0.0 : NaN;
    }
  }
  const partial = packWeatherFieldDetailed(
    { gridWidth: gw, gridHeight: gh, coverage, bounds: globalBounds() },
    TEX_W,
    TEX_H,
  );
  assert.ok(partial.filledTexels > 0 && partial.observedTexels > 0);
  const procedural = buildProceduralWeatherMap(TEX_W, TEX_H);

  // A texel is unobserved iff repacking with a `constant` fill of coverage 1
  // hands back exactly 255 there — the constant path writes the quad verbatim
  // and is not restored, so this identifies the fill REGION independently of
  // the procedural path under test. Restrict to rows the low-pass leaves alone
  // plus the polar band, excluding the two collapsed cap rows.
  const probe = packWeatherFieldDetailed(
    { gridWidth: gw, gridHeight: gh, coverage, bounds: globalBounds() },
    TEX_W,
    TEX_H,
    { noDataFill: { kind: "constant", coverage: 1 } },
  );
  let checked = 0;
  let polarBandChecked = 0;
  for (let ty = 1; ty < TEX_H - 1; ty++) {
    for (let tx = 0; tx < TEX_W; tx++) {
      if (channelAt(probe.bytes, tx, ty, 0) !== 255) {
        continue; // observed, or blurred by the seam — not a clean fill texel
      }
      for (let channel = 0; channel < 4; channel++) {
        assert.equal(
          channelAt(partial.bytes, tx, ty, channel),
          channelAt(procedural, tx, ty, channel),
          `unobserved texel ${tx},${ty},${channel} drifted from the no-provider map`,
        );
      }
      checked++;
      if (!isIdentityRow(ty)) {
        polarBandChecked++;
      }
    }
  }
  assert.ok(checked > 1000, `the sweep must reach fill texels, saw ${checked}`);
  // The polar band is where the second filter actually bit; a sweep that never
  // reached it would pass vacuously.
  assert.ok(
    polarBandChecked > 100,
    `the sweep must reach the polar band, saw ${polarBandChecked}`,
  );
});

test("the restore pass does NOT re-open the polar cap C13-07 closed", () => {
  // Part observed, part filled, at the cap. If the fill were restored there,
  // the cap row would carry two values around the azimuth ring — exactly the
  // per-azimuth read C13-07 removed.
  const gw = 8;
  const gh = 8;
  const coverage = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      coverage[y * gw + x] = x < gw / 2 ? 0.0 : NaN;
    }
  }
  const result = packWeatherFieldDetailed(
    { gridWidth: gw, gridHeight: gh, coverage, bounds: globalBounds() },
    TEX_W,
    TEX_H,
  );
  for (const ty of [0, TEX_H - 1]) {
    assert.ok(!isIdentityRow(ty), "row must be a polar cap row");
    for (let channel = 0; channel < 4; channel++) {
      const first = channelAt(result.bytes, 0, ty, channel);
      for (let tx = 1; tx < TEX_W; tx++) {
        assert.equal(
          channelAt(result.bytes, tx, ty, channel),
          first,
          `cap row ${ty} channel ${channel} is not single-valued at ${tx}`,
        );
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Regional bounds are HONOURED
// ─────────────────────────────────────────────────────────────────────────────

const CONUS = {
  west: -125 * DEG,
  east: -66 * DEG,
  south: 24 * DEG,
  north: 50 * DEG,
};

test("a regional field lands on its own rectangle, not on the planet", () => {
  const field = rampField(CONUS);
  const result = packWeatherFieldDetailed(field, TEX_W, TEX_H);
  assert.equal(result.global, false);
  assert.ok(
    result.observedTexels > 0 && result.filledTexels > 0,
    "a regional field must both observe and fill",
  );
  assert.equal(result.observedTexels + result.filledTexels, TEX_W * TEX_H);
  // The rectangle's true area share, in texels, within one texel per edge.
  const expected =
    ((CONUS.east - CONUS.west) / (2 * Math.PI)) *
    TEX_W *
    (((CONUS.north - CONUS.south) / Math.PI) * TEX_H);
  assert.ok(
    Math.abs(result.observedTexels - expected) < 0.15 * expected,
    `observed ${result.observedTexels} texels vs expected ~${expected.toFixed(0)}`,
  );

  // A west->east ramp reveals the sample position: inside the rectangle the byte
  // must track the position WITHIN the rectangle, not within the planet.
  const ty = texelYForLat(37);
  assert.ok(isIdentityRow(ty));
  for (const lon of [-124, -110, -95.5, -80, -67]) {
    const tx = texelXForLon(lon);
    const s = (lon - -125) / (-66 - -125);
    const got = channelAt(result.bytes, tx, ty, 0);
    assert.ok(
      Math.abs(got - Math.round(255 * s)) <= 4,
      `lon ${lon}: got ${got}, expected ~${Math.round(255 * s)}`,
    );
  }
});

test("DEFECT ORACLE — the pre-C13-08 packer DID stretch that field globally", () => {
  const field = rampField(CONUS);
  const before = legacyPackWeatherField(field, TEX_W, TEX_H);
  const after = packWeatherField(field, TEX_W, TEX_H);
  const ty = texelYForLat(37);
  // Legacy: the ramp runs from 0 at lon -180 to 255 at lon +180 — the field is
  // smeared over the whole planet, and lon 0 (far outside CONUS) reads mid-ramp.
  assert.ok(
    Math.abs(channelAt(before, texelXForLon(-179), ty, 0) - 0) <= 3,
    "legacy oracle is inert: it did not anchor the ramp at lon -180",
  );
  assert.ok(
    Math.abs(channelAt(before, texelXForLon(0), ty, 0) - 128) <= 4,
    "legacy oracle is inert: lon 0 should have read the ramp midpoint",
  );
  // Now: lon 0 is outside CONUS and reads the procedural fill instead.
  const procedural = buildProceduralWeatherMap(TEX_W, TEX_H);
  const tx0 = texelXForLon(0);
  assert.equal(
    channelAt(after, tx0, ty, 0),
    channelAt(procedural, tx0, ty, 0),
    "a texel outside the regional bounds must carry the fill",
  );
  let differing = 0;
  for (let i = 0; i < after.length; i += 4) {
    if (after[i] !== before[i]) {
      differing++;
    }
  }
  assert.ok(
    differing > 0.5 * TEX_W * TEX_H,
    `only ${differing} texels changed — the regional fix barely moved anything`,
  );
});

test("an ANTIMERIDIAN-STRADDLING regional field lands on both sides of +-180", () => {
  const bounds = {
    west: 170 * DEG,
    east: -170 * DEG,
    south: -5 * DEG,
    north: 5 * DEG,
  };
  const result = packWeatherFieldDetailed(rampField(bounds), TEX_W, TEX_H);
  assert.equal(result.global, false);
  const ty = texelYForLat(0);
  assert.ok(isIdentityRow(ty));
  const procedural = buildProceduralWeatherMap(TEX_W, TEX_H);
  // Inside: the ramp increases eastward THROUGH the seam.
  const samples = [
    [172, (172 - 170) / 20],
    [178, (178 - 170) / 20],
    [-178, (182 - 170) / 20],
    [-172, (188 - 170) / 20],
  ];
  let previous = -1;
  for (const [lon, s] of samples) {
    const tx = texelXForLon(lon);
    const got = channelAt(result.bytes, tx, ty, 0);
    assert.ok(
      Math.abs(got - Math.round(255 * s)) <= 6,
      `lon ${lon}: got ${got}, expected ~${Math.round(255 * s)}`,
    );
    assert.ok(got > previous, `ramp must increase eastward through the seam`);
    previous = got;
  }
  // Outside (the other 340 degrees): the fill, byte for byte.
  for (const lon of [0, 90, -90, 150, -150]) {
    const tx = texelXForLon(lon);
    assert.equal(
      channelAt(result.bytes, tx, ty, 0),
      channelAt(procedural, tx, ty, 0),
      `lon ${lon} is outside the straddling rectangle and must carry the fill`,
    );
  }
  // The same window written with an unwrapped east bound packs identically.
  const unwrapped = packWeatherField(
    rampField({ ...bounds, east: 190 * DEG }),
    TEX_W,
    TEX_H,
  );
  const wrapped = result.bytes;
  for (let i = 0; i < wrapped.length; i++) {
    assert.equal(unwrapped[i], wrapped[i], `unwrapped-east drift at byte ${i}`);
  }
});

test("a regional field keeps the poles single-valued", () => {
  const packed = packWeatherField(rampField(CONUS), TEX_W, TEX_H);
  for (const ty of [0, TEX_H - 1]) {
    for (let channel = 0; channel < 4; channel++) {
      const first = channelAt(packed, 0, ty, channel);
      for (let tx = 1; tx < TEX_W; tx++) {
        assert.equal(
          channelAt(packed, tx, ty, channel),
          first,
          `polar row ${ty} channel ${channel} varies with longitude`,
        );
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. No-data semantics
// ─────────────────────────────────────────────────────────────────────────────

test("a NaN hole inside a global field becomes fill, not clear", () => {
  const gw = 16;
  const gh = 8;
  const coverage = new Float32Array(gw * gh).fill(0.9);
  // A 4x3 hole well inside the grid.
  for (let y = 2; y < 5; y++) {
    for (let x = 4; x < 8; x++) {
      coverage[y * gw + x] = NaN;
    }
  }
  const result = packWeatherFieldDetailed(
    { gridWidth: gw, gridHeight: gh, coverage, bounds: globalBounds() },
    TEX_W,
    TEX_H,
  );
  assert.ok(result.filledTexels > 0, "the hole produced no filled texels");
  assert.ok(result.observedTexels > 0);
  const procedural = buildProceduralWeatherMap(TEX_W, TEX_H);
  // The hole's interior carries the procedural bytes...
  const cx = Math.round(((4 + 7) / 2 / (gw - 1)) * TEX_W - 0.5);
  const cy = Math.round(((2 + 4) / 2 / (gh - 1)) * TEX_H - 0.5);
  assert.equal(
    channelAt(result.bytes, cx, cy, 0),
    channelAt(procedural, cx, cy, 0),
  );
  // ...and 0.9 coverage is NOT what the fill happens to be there (else inert).
  // (0.9 round-trips through Float32 as 0.89999997, so the byte is 229 not 230.)
  const observedByte = Math.round(Math.fround(0.9) * 255);
  assert.notEqual(channelAt(procedural, cx, cy, 0), observedByte);
  // Away from the hole the observed 0.9 survives untouched.
  assert.equal(channelAt(result.bytes, 5, 64, 0), observedByte);
});

test("a declared sentinel is honoured, and 0 stays an OBSERVATION", () => {
  const gw = 8;
  const gh = 4;
  const coverage = new Float32Array(gw * gh).fill(0);
  for (let y = 0; y < gh; y++) {
    for (let x = 4; x < gw; x++) {
      coverage[y * gw + x] = -9999;
    }
  }
  const withSentinel = packWeatherFieldDetailed(
    {
      gridWidth: gw,
      gridHeight: gh,
      coverage,
      bounds: globalBounds(),
      noDataValue: -9999,
    },
    TEX_W,
    TEX_H,
  );
  assert.ok(withSentinel.filledTexels > 0);
  assert.ok(withSentinel.observedTexels > 0);
  // The observed half is an observation OF CLEAR: byte 0, not fill.
  const ty = 64;
  assert.equal(channelAt(withSentinel.bytes, 2, ty, 0), 0);
  // Without the declaration the same array has no gaps at all (clamped to 0),
  // which is exactly why the sentinel has to be declared.
  const withoutSentinel = packWeatherFieldDetailed(
    { gridWidth: gw, gridHeight: gh, coverage, bounds: globalBounds() },
    TEX_W,
    TEX_H,
  );
  assert.equal(withoutSentinel.filledTexels, 0);
});

test("a constant fill is honoured and encoded like any other texel", () => {
  const empty = {
    gridWidth: 4,
    gridHeight: 4,
    coverage: new Float32Array(16).fill(NaN),
    bounds: globalBounds(),
    noDataFill: {
      kind: "constant",
      coverage: 0.25,
      type: 5,
      baseMeters: 6000,
      densityBias: 0.75,
    },
  };
  const result = packWeatherFieldDetailed(empty, TEX_W, TEX_H);
  assert.equal(result.fillKind, "constant");
  assert.equal(result.observedTexels, 0);
  const ty = 64;
  assert.ok(isIdentityRow(ty));
  assert.equal(channelAt(result.bytes, 10, ty, 0), Math.round(0.25 * 255));
  assert.equal(channelAt(result.bytes, 10, ty, 1), Math.round((5 / 10) * 255));
  assert.equal(
    channelAt(result.bytes, 10, ty, 2),
    Math.round((6000 / 12000) * 255),
  );
  assert.equal(channelAt(result.bytes, 10, ty, 3), Math.round(0.75 * 255));
  // The packer option OVERRIDES the field's declaration.
  const overridden = packWeatherFieldDetailed(empty, TEX_W, TEX_H, {
    noDataFill: { kind: "constant", coverage: 1 },
  });
  assert.equal(channelAt(overridden.bytes, 10, ty, 0), 255);
  assert.equal(channelAt(overridden.bytes, 10, ty, 1), 128);
  assert.equal(channelAt(overridden.bytes, 10, ty, 2), 0);
  assert.equal(channelAt(overridden.bytes, 10, ty, 3), 128);
});

test("a ZERO-WEIGHT observation is no-data, not a fabricated clear texel", () => {
  // Construct the one geometry where a VALID tap can carry weight ZERO: with
  // `gw = 2*texW + 1` the node-registered resample coordinate `((tx+0.5)/texW) *
  // (gw-1)` is an exact ODD INTEGER for every texel, so `tx = ty = 0` and only
  // the `i00` tap has non-zero bilinear weight. Put the single observation on
  // the `i11` tap of exactly one texel: that texel has `valid = 1` but a total
  // weight of 0, and renormalizing would divide 0 by 0 and encode the NaN as
  // byte 0 — an observed clear sky nobody reported.
  const texW = 4;
  const texH = 4;
  const gw = 2 * texW + 1;
  const gh = 2 * texH + 1;
  const coverage = new Float32Array(gw * gh).fill(NaN);
  // Texel (0,1) resolves to fx=1, fy=3, so its taps are columns {1,2} x rows
  // {3,4}; (col 2, row 4) is its i11 — and no other texel touches that node.
  coverage[4 * gw + 2] = 1;
  const fillByte = 128;
  const result = packWeatherFieldDetailed(
    {
      gridWidth: gw,
      gridHeight: gh,
      coverage,
      bounds: globalBounds(),
      noDataFill: { kind: "constant", coverage: fillByte / 255 },
    },
    texW,
    texH,
  );
  for (let i = 0; i < texW * texH; i++) {
    assert.equal(
      result.bytes[i * 4],
      fillByte,
      `texel ${i} did not take the fill (byte ${result.bytes[i * 4]}) — a 0 here would read as observed clear sky`,
    );
  }
  assert.equal(result.observedTexels, 0, "no texel carries real weight here");
  assert.equal(result.filledTexels, texW * texH);
});

test("a bounds-less field keeps its historical GLOBAL behaviour (public API)", () => {
  // `packWeatherField` is exported on the Cesium namespace and pre-C13-08
  // callers never had to supply meaningful bounds, because nothing read them.
  const field = rampField();
  delete field.bounds;
  const packed = packWeatherField(field, TEX_W, TEX_H);
  const before = legacyPackWeatherField(rampField(), TEX_W, TEX_H);
  for (let i = 0; i < packed.length; i++) {
    assert.equal(packed[i], before[i], `byte ${i} changed without bounds`);
  }
});

test("the fill does NOT bleed inward: a partial tap set renormalizes", () => {
  // Two columns: an observed 1.0 and a no-data. Every texel that touches the
  // observed column must read exactly 1.0 — never a blend toward the fill, and
  // never a blend toward zero.
  const gw = 4;
  const gh = 2;
  const coverage = Float32Array.from([1, NaN, NaN, NaN, 1, NaN, NaN, NaN]);
  const result = packWeatherFieldDetailed(
    {
      gridWidth: gw,
      gridHeight: gh,
      coverage,
      bounds: globalBounds(),
      noDataFill: { kind: "constant", coverage: 0 },
    },
    TEX_W,
    TEX_H,
  );
  const ty = 64;
  let observed = 0;
  for (let tx = 0; tx < TEX_W; tx++) {
    const byte = channelAt(result.bytes, tx, ty, 0);
    assert.ok(
      byte === 0 || byte === 255,
      `texel ${tx} blended observation with fill: ${byte}`,
    );
    if (byte === 255) {
      observed++;
    }
  }
  assert.ok(observed > 0, "the observed column vanished");
  assert.ok(observed < TEX_W, "everything read as observed");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Cell registration + the wrap that only it can reach
// ─────────────────────────────────────────────────────────────────────────────

test("a CELL-registered global field wraps across the antimeridian", () => {
  const gw = 8;
  const gh = 4;
  const coverage = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    // Only the two columns adjacent to the seam are lit; under a clamped fetch
    // the westernmost texels could only see column 0.
    coverage[y * gw + 0] = 1;
    coverage[y * gw + (gw - 1)] = 1;
  }
  const field = {
    gridWidth: gw,
    gridHeight: gh,
    coverage,
    bounds: globalBounds(),
    registration: "cell",
  };
  const result = packWeatherFieldDetailed(field, TEX_W, TEX_H);
  assert.equal(result.registration, "cell");
  const ty = 64;
  // The texel just east of -180 and the texel just west of +180 both sit between
  // the two lit cell centres, so a wrap-aware fetch keeps them fully lit.
  assert.equal(channelAt(result.bytes, 0, ty, 0), 255);
  assert.equal(channelAt(result.bytes, TEX_W - 1, ty, 0), 255);
  // ...and the middle of the map is dark, so this is not a constant field.
  assert.equal(channelAt(result.bytes, TEX_W / 2, ty, 0), 0);
});

test("cell vs node registration differ by exactly half a source cell", () => {
  const gw = 32;
  const gh = 16;
  const field = rampField(globalBounds(), gw, gh);
  const asNode = packWeatherField(field, TEX_W, TEX_H);
  const asCell = packWeatherField(
    { ...field, registration: "cell" },
    TEX_W,
    TEX_H,
  );
  const ty = 64;
  let differing = 0;
  for (let tx = 0; tx < TEX_W; tx++) {
    if (channelAt(asNode, tx, ty, 0) !== channelAt(asCell, tx, ty, 0)) {
      differing++;
    }
  }
  assert.ok(
    differing > TEX_W / 2,
    `only ${differing} texels differ — the registration switch is inert`,
  );
  // Mid-map, the cell-registered ramp is exactly half a cell east of the node one
  // in SOURCE units, i.e. it reads a slightly LARGER ramp value.
  const tx = TEX_W / 2;
  assert.ok(channelAt(asCell, tx, ty, 0) >= channelAt(asNode, tx, ty, 0));
});

test("a regional CELL field clamps its continuous W/E/N/S edge coordinates", () => {
  const texW = 360;
  const texH = 180;
  const field = {
    gridWidth: 2,
    gridHeight: 2,
    // Independent horizontal and vertical slopes expose each boundary's
    // interpolation. Source-cell centres are at +/-5 degrees; the regional
    // bounds are their outer edges at +/-10 degrees.
    coverage: new Float32Array([0.2, 0.4, 0.6, 0.8]),
    bounds: {
      west: -10 * DEG,
      south: -10 * DEG,
      east: 10 * DEG,
      north: 10 * DEG,
    },
    registration: "cell",
    noDataFill: { kind: "constant", coverage: 0 },
  };
  const result = packWeatherFieldDetailed(field, texW, texH);

  // These are the first/last in-bounds texel centres: +/-9.5 degrees. Along
  // the other axis, +/-0.5 degrees gives source fraction 0.45. A clamp-to-edge
  // sample therefore keeps the boundary cell while interpolating only along
  // the orthogonal axis. The historical index-only clamp returned 74 at west
  // and 28 at north by retaining a -0.45 interpolation fraction.
  assert.equal(channelAt(result.bytes, 170, 89, 0, texW), 97, "west");
  assert.equal(channelAt(result.bytes, 189, 89, 0, texW), 148, "east");
  assert.equal(channelAt(result.bytes, 179, 80, 0, texW), 74, "north");
  assert.equal(channelAt(result.bytes, 179, 99, 0, texW), 176, "south");
});

test("a regional CELL no-data corner cannot read a diagonal observation", () => {
  const texW = 360;
  const texH = 180;
  const fillCoverage = 0.125;
  const field = {
    gridWidth: 2,
    gridHeight: 2,
    // The north-west boundary cell is no-data. With unclamped negative tx/ty,
    // the diagonally-opposite south-east observation acquired a positive
    // (-tx * -ty) weight and leaked all the way into that outer corner.
    coverage: new Float32Array([NaN, NaN, NaN, 1]),
    bounds: {
      west: -10 * DEG,
      south: -10 * DEG,
      east: 10 * DEG,
      north: 10 * DEG,
    },
    registration: "cell",
    noDataFill: { kind: "constant", coverage: fillCoverage },
  };
  const result = packWeatherFieldDetailed(field, texW, texH);

  assert.equal(
    channelAt(result.bytes, 170, 80, 0, texW),
    Math.round(fillCoverage * 255),
  );
  assert.ok(result.observedTexels > 0, "the diagonal observation must remain");
  assert.ok(result.filledTexels > 0, "the no-data corner must remain fill");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The provider contract: sources declare bounds/registration/no-data
// ─────────────────────────────────────────────────────────────────────────────

test("CoverageJSON bounds come from the coverage's own axes, and null is no-data", () => {
  const cov = {
    domain: {
      axes: { x: { values: [-120, -110, -100] }, y: { values: [40, 30] } },
    },
    ranges: { TCDC: { values: [10, null, 30, 40, 50, 60] } },
  };
  const field = parseCoverageJson(cov, {
    parameterName: "TCDC",
    units: "percent",
    bounds: globalBounds(),
  });
  assert.equal(field.registration, "node");
  assert.ok(Math.abs(field.bounds.west - -120 * DEG) < 1e-12);
  assert.ok(Math.abs(field.bounds.east - -100 * DEG) < 1e-12);
  assert.ok(Math.abs(field.bounds.north - 40 * DEG) < 1e-12);
  assert.ok(Math.abs(field.bounds.south - 30 * DEG) < 1e-12);
  assert.ok(Number.isNaN(field.coverage[1]), "null must parse as no-data");
  assert.ok(Math.abs(field.coverage[0] - 0.1) < 1e-6);
  // Degenerate axes fall back to the requested bbox.
  const degenerate = parseCoverageJson(
    {
      domain: { axes: { x: { values: [5] }, y: { values: [5] } } },
      ranges: { TCDC: { values: [42] } },
    },
    { parameterName: "TCDC", units: "percent", bounds: CONUS },
  );
  assert.deepEqual(degenerate.bounds, CONUS);
});

test("the committed EDR/WCS fixtures still derive EXACTLY the global bounds", () => {
  // Those fixtures back `/mock-edr` and `/mock-wcs`, so this is what keeps the
  // two mock ingest probes byte-identical across C13-08.
  for (const name of ["edr-cube-tcc.json", "wcs-coverage.json"]) {
    const cov = JSON.parse(
      fs.readFileSync(
        path.join(root, "Tools/visual-regression/fixtures", name),
        "utf8",
      ),
    );
    const field = parseCoverageJson(cov, {
      parameterName: "TCDC",
      units: "percent",
      bounds: CONUS, // deliberately WRONG, to prove the axes win
    });
    assert.deepEqual(
      field.bounds,
      {
        west: GLOBAL_WEATHER_BOUNDS.west,
        south: GLOBAL_WEATHER_BOUNDS.south,
        east: GLOBAL_WEATHER_BOUNDS.east,
        north: GLOBAL_WEATHER_BOUNDS.north,
      },
      `${name} must derive the global rectangle`,
    );
    assert.equal(isGlobalWeatherWindow(field.bounds), true);
    assert.equal(
      packWeatherFieldDetailed(field, TEX_W, TEX_H).filledTexels,
      0,
      `${name} must still pack as a full global map`,
    );
  }
});

test("METAR: out-of-radius is NO-DATA, an SKC station is an observed clear", () => {
  const source = new MetarWeatherSource({
    stations: [
      { lon: 0, lat: 0, raw: "KXXX 121653Z 09008KT 10SM SKC 24/13 A2998" },
      { lon: 30, lat: 0, raw: "KYYY 121653Z 09008KT 10SM OVC020 24/13 A2998" },
    ],
    gridWidth: 36,
    gridHeight: 18,
    influenceRadiusDeg: 20,
  });
  return source.fetchField({}).then((field) => {
    assert.equal(field.registration, "node");
    const at = (lonDeg, latDeg) => {
      const x = Math.round(((lonDeg + 180) / 360) * (field.gridWidth - 1));
      const y = Math.round(((90 - latDeg) / 180) * (field.gridHeight - 1));
      return field.coverage[y * field.gridWidth + x];
    };
    assert.equal(at(0, 0), 0, "the SKC station must read an OBSERVED clear 0");
    assert.ok(at(30, 0) > 0.9, "the OVC station must read near-overcast");
    assert.ok(
      Number.isNaN(at(-150, -60)),
      "a cell with no station in range must be NO-DATA, not clear",
    );
    // And the packer turns exactly those into fill.
    const result = packWeatherFieldDetailed(field, TEX_W, TEX_H);
    assert.ok(result.filledTexels > 0 && result.observedTexels > 0);
  });
});

test("SyntheticWeatherSource carries a REGIONAL request through to the packer", () => {
  const source = new SyntheticWeatherSource("eastwest");
  return Promise.all([
    source.fetchField({}),
    source.fetchField({ bounds: CONUS }),
  ]).then(([globalField, regionalField]) => {
    assert.equal(isGlobalWeatherWindow(globalField.bounds), true);
    assert.deepEqual(regionalField.bounds, CONUS);
    assert.equal(
      packWeatherFieldDetailed(globalField, TEX_W, TEX_H).filledTexels,
      0,
    );
    const regional = packWeatherFieldDetailed(regionalField, TEX_W, TEX_H);
    assert.ok(regional.filledTexels > 0 && regional.observedTexels > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Wiring — the texture stays global; placement happens in the packer
// ─────────────────────────────────────────────────────────────────────────────

test("the renderer still packs GLOBAL weatherTexBounds", () => {
  // C13-08 deliberately does NOT re-point weatherTexBounds at a regional
  // rectangle: the sampler repeats in U, so a regional bounds uniform would TILE
  // the region across the planet. The regional rectangle is honoured by writing
  // the field into the matching texels instead.
  const packIndex = rendererSource.indexOf("68-71 weatherTexBounds");
  assert.notEqual(packIndex, -1, "weatherTexBounds pack comment missing");
  const packBlock = rendererSource.slice(packIndex, packIndex + 400);
  for (const expr of [
    "data[offset++] = -Math.PI;",
    "data[offset++] = -Math.PI / 2.0;",
    "data[offset++] = 2.0 * Math.PI;",
    "data[offset++] = Math.PI;",
  ]) {
    assert.ok(
      packBlock.includes(expr),
      `weatherTexBounds must stay global — \`${expr}\` disappeared`,
    );
  }
});

test("the packer owns the placement — no source re-implements it", () => {
  const dir = path.join(root, "packages/engine/Source/Scene/Weather");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    if (file === "WeatherTexPacker.ts" || file === "WeatherFieldGrid.ts") {
      continue;
    }
    const source = readEngine(`Scene/Weather/${file}`);
    assert.ok(
      !/weatherFieldGridCoordinate|weatherFieldU\(|weatherFieldV\(/.test(
        source,
      ),
      `${file} resolves field placement itself — that belongs to the packer`,
    );
  }
});
