// C13-07 — dateline/pole-safe global weather-map sampling contract.
// @purpose Pins the one equirect weather-map convention shared by CPU producers and, textually, the WGSL/sampler half: seam filters, UV mapping, bounds pack.
// @status ACTIVE
//
// Pins the ONE equirectangular convention now shared by
//   - Scene/Weather/WeatherMapSeam.ts        (the convention + the two filters)
//   - Scene/Weather/ProceduralWeatherMap.ts  (the default global producer)
//   - Scene/Weather/WeatherTexPacker.ts      (the real-data producer)
//   - Shaders/WebGPU/Environment/ProceduralClouds.wgsl  (`worldToWeatherUV`)
//   - Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts  (sampler + bounds pack)
//
// The GPU half of that list cannot be executed here, so it is pinned TEXTUALLY:
// the sampler address modes, the packed `weatherTexBounds`, and the WGSL UV
// expressions are the exact things a future edit could desynchronise from the
// CPU producers, and each has an assertion below.
//
// RUNNER REQUIREMENT: Node >= 22.18 (this spec statically imports `.ts` modules
// and relies on Node's built-in type stripping).
//   node --test Tools/visual-regression/weather-map-seam.spec.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  fitSpectralSlope,
  radialPowerSpectrum,
} from "./lib/cloud-spectrum.mjs";
import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

// Engine `.ts` files import each other with `.js` specifiers; the hook must be
// installed before those modules load, hence the dynamic imports below.
enableEngineTsResolution();
const {
  applyEquirectPolarLowPass,
  periodicFbm2D,
  periodicFbmRow,
  periodicValueNoise2D,
  polarLowPassWidth,
  weatherTexelCenterLonLat,
  weatherUVFromLonLat,
  WEATHER_MAP_LAT_RANGE,
  WEATHER_MAP_LON_RANGE,
  WEATHER_MAP_MIN_LAT,
  WEATHER_MAP_MIN_LON,
  WEATHER_MAP_TEX_HEIGHT,
  WEATHER_MAP_TEX_WIDTH,
} =
  await import("../../packages/engine/Source/Scene/Weather/WeatherMapSeam.ts");
const { buildProceduralWeatherMap } =
  await import("../../packages/engine/Source/Scene/Weather/ProceduralWeatherMap.ts");
const { packWeatherField } =
  await import("../../packages/engine/Source/Scene/Weather/WeatherTexPacker.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const wgslSource = fs.readFileSync(
  path.join(
    root,
    "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
  ),
  "utf8",
);
const rendererSource = fs.readFileSync(
  path.join(
    root,
    "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
  ),
  "utf8",
);

// The ONE definition of the weather-texture size, imported rather than
// hand-copied. The renderer's `WEATHER_TEX_W` / `WEATHER_TEX_H` literals are a
// second spelling of it (a WebGPU-only module a backend-neutral Scene file must
// not import), and "the renderer's weather-texture size is the seam module's"
// below asserts textually that the two agree.
const TEX_W = WEATHER_MAP_TEX_WIDTH;
const TEX_H = WEATHER_MAP_TEX_HEIGHT;

/** WGS84 equatorial circumference, km — the km/texel denominator. */
const EARTH_CIRCUMFERENCE_KM = 40030;
/** Metres of ground per weather texel at the equator. */
const METRES_PER_TEXEL = (EARTH_CIRCUMFERENCE_KM * 1000) / TEX_W;

function functionSource(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  assert.notEqual(start, -1, `missing WGSL function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`unterminated WGSL function ${name}`);
}

/** The pre-C13-07 aperiodic value-noise fBM, kept as the defect oracle. */
function legacyFbm(x, y) {
  const hash = (hx, hy) => {
    const n = Math.sin(hx * 127.1 + hy * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const vnoise = (vx, vy) => {
    const ix = Math.floor(vx);
    const iy = Math.floor(vy);
    const fx = vx - ix;
    const fy = vy - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    return (
      hash(ix, iy) * (1 - ux) * (1 - uy) +
      hash(ix + 1, iy) * ux * (1 - uy) +
      hash(ix, iy + 1) * (1 - ux) * uy +
      hash(ix + 1, iy + 1) * ux * uy
    );
  };
  let v = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < 5; i++) {
    v += amp * vnoise(x * f, y * f);
    f *= 2;
    amp *= 0.5;
  }
  return v;
}

function channelAt(bytes, tx, ty, channel, texW = TEX_W) {
  return bytes[(ty * texW + tx) * 4 + channel];
}

/** Rows the polar low-pass leaves untouched — where periodicity alone must hold. */
function unfilteredRows(texH = TEX_H, texW = TEX_W) {
  const rows = [];
  for (let ty = 0; ty < texH; ty++) {
    if (polarLowPassWidth(ty, texH, texW) === 1) {
      rows.push(ty);
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The shared convention
// ─────────────────────────────────────────────────────────────────────────────

test("weather-map bounds match the floats the renderer packs into weatherTexBounds", () => {
  assert.equal(WEATHER_MAP_MIN_LON, -Math.PI);
  assert.equal(WEATHER_MAP_MIN_LAT, -Math.PI / 2);
  assert.equal(WEATHER_MAP_LON_RANGE, 2 * Math.PI);
  assert.equal(WEATHER_MAP_LAT_RANGE, Math.PI);
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
      `weatherTexBounds pack no longer writes \`${expr}\` — the CPU twin's WEATHER_MAP_* constants would drift`,
    );
  }
});

test("CPU weatherUVFromLonLat is expression-identical to WGSL worldToWeatherUV", () => {
  const fn = functionSource(wgslSource, "worldToWeatherUV");
  assert.ok(
    fn.includes("let u = (lon - b.x) / b.z;"),
    "WGSL u expression changed",
  );
  assert.ok(
    fn.includes("let v = 1.0 - (lat - b.y) / b.w;"),
    "WGSL v expression changed",
  );
  // Same formula, evaluated on the CPU with the same bounds.
  for (const lon of [-Math.PI, -1.2, 0, 0.37, Math.PI]) {
    for (const lat of [-Math.PI / 2, -0.9, 0, 0.44, Math.PI / 2]) {
      const [u, v] = weatherUVFromLonLat(lon, lat);
      assert.ok(
        Math.abs(u - (lon - WEATHER_MAP_MIN_LON) / WEATHER_MAP_LON_RANGE) <
          1e-15,
      );
      assert.ok(
        Math.abs(
          v - (1.0 - (lat - WEATHER_MAP_MIN_LAT) / WEATHER_MAP_LAT_RANGE),
        ) < 1e-15,
      );
    }
  }
  assert.deepEqual(weatherUVFromLonLat(-Math.PI, Math.PI / 2), [0, 0]);
  assert.deepEqual(weatherUVFromLonLat(Math.PI, -Math.PI / 2), [1, 1]);
});

test("producer texel centres invert the sampler's UV mapping exactly", () => {
  for (const tx of [0, 1, 37, 128, TEX_W - 2, TEX_W - 1]) {
    for (const ty of [0, 1, 63, 64, TEX_H - 2, TEX_H - 1]) {
      const [lon, lat] = weatherTexelCenterLonLat(tx, ty, TEX_W, TEX_H);
      const [u, v] = weatherUVFromLonLat(lon, lat);
      assert.ok(
        Math.abs(u - (tx + 0.5) / TEX_W) < 1e-12,
        `u round-trip failed at tx=${tx}`,
      );
      assert.ok(
        Math.abs(v - (ty + 0.5) / TEX_H) < 1e-12,
        `v round-trip failed at ty=${ty}`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Dateline (antimeridian)
// ─────────────────────────────────────────────────────────────────────────────

test("the weather sampler wraps in longitude and clamps at the poles", () => {
  const index = rendererSource.indexOf(
    "cache.weatherSampler = device.createSampler(",
  );
  assert.notEqual(index, -1, "weatherSampler creation missing");
  const block = rendererSource.slice(index, index + 300);
  assert.ok(
    block.includes('addressModeU: "repeat"'),
    "weather sampler must repeat in U — the seam fix assumes texel W-1 filters against texel 0",
  );
  assert.ok(
    block.includes('addressModeV: "clamp-to-edge"'),
    "weather sampler must clamp in V — the pole fix assumes the polar row is what a pole sample reads",
  );
});

test("periodicFbm2D is exactly periodic in longitude, per octave stack", () => {
  for (const period of [6, 18]) {
    for (let i = 0; i < 64; i++) {
      const y = (i / 64) * 18;
      assert.equal(
        periodicFbm2D(0, y, period),
        periodicFbm2D(period, y, period),
        `periodicFbm2D not periodic at period=${period}, y=${y}`,
      );
      // Single-octave lattice wrap, too.
      assert.equal(
        periodicValueNoise2D(0, y, period),
        periodicValueNoise2D(period, y, period),
      );
    }
  }
});

test("periodicFbm2D is CONTINUOUS across the wrap, not merely equal at the joint", () => {
  const period = 18;
  const step = period / 4096; // one sub-texel step
  for (let i = 0; i < 32; i++) {
    const y = (i / 32) * 18;
    const wrapStep = Math.abs(
      periodicFbm2D(step, y, period) - periodicFbm2D(period - step, y, period),
    );
    // Largest interior step of the SAME width anywhere along the row. A merely
    // periodic-but-kinked function would blow past this.
    let interiorMax = 0;
    for (let s = 0; s < 512; s++) {
      const x = (s / 512) * period;
      interiorMax = Math.max(
        interiorMax,
        Math.abs(
          periodicFbm2D(x + 2 * step, y, period) - periodicFbm2D(x, y, period),
        ),
      );
    }
    assert.ok(
      wrapStep <= interiorMax,
      `wrap step ${wrapStep} exceeds the largest interior step ${interiorMax} at y=${y}`,
    );
  }
});

test("the legacy aperiodic fBM WOULD fail the periodicity contract (defect oracle)", () => {
  let worst = 0;
  for (let i = 0; i < 64; i++) {
    const y = (i / 64) * 18;
    worst = Math.max(worst, Math.abs(legacyFbm(0, y) - legacyFbm(18, y)));
  }
  assert.ok(
    worst > 0.1,
    `defect oracle is inert (worst legacy endpoint delta ${worst}) — the periodicity test would not catch a regression`,
  );
});

test("the procedural map has no antimeridian discontinuity", () => {
  const map = buildProceduralWeatherMap(TEX_W, TEX_H);
  const rows = unfilteredRows();
  // The identity band is |lat| < 60 deg, two thirds of the sphere's latitude
  // range, so this holds at any texture height rather than only at 128 rows.
  assert.ok(
    rows.length > 0.6 * TEX_H,
    `expected most of the ${TEX_H} rows to be low-pass-free, got ${rows.length}`,
  );

  let wrapMax = 0;
  let interiorMax = 0;
  for (const ty of rows) {
    wrapMax = Math.max(
      wrapMax,
      Math.abs(channelAt(map, 0, ty, 0) - channelAt(map, TEX_W - 1, ty, 0)),
    );
    for (let tx = 0; tx < TEX_W - 1; tx++) {
      interiorMax = Math.max(
        interiorMax,
        Math.abs(channelAt(map, tx, ty, 0) - channelAt(map, tx + 1, ty, 0)),
      );
    }
  }
  assert.ok(
    wrapMax <= interiorMax,
    `antimeridian step ${wrapMax}/255 exceeds the largest interior step ${interiorMax}/255`,
  );

  // Every row (including the filtered polar band) must wrap cleanly on ALL
  // channels — the low-pass is circular, so it cannot introduce a seam either.
  for (let ty = 0; ty < TEX_H; ty++) {
    for (let channel = 0; channel < 4; channel++) {
      const step = Math.abs(
        channelAt(map, 0, ty, channel) - channelAt(map, TEX_W - 1, ty, channel),
      );
      assert.ok(
        step <= interiorMax,
        `row ${ty} channel ${channel} wraps with a step of ${step}`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Poles
// ─────────────────────────────────────────────────────────────────────────────

test("polarLowPassWidth is 1 (exact identity) away from the poles and full-row at them", () => {
  assert.equal(polarLowPassWidth(0, TEX_H, TEX_W), TEX_W);
  assert.equal(polarLowPassWidth(TEX_H - 1, TEX_H, TEX_W), TEX_W);
  const dLatDeg = 180 / TEX_H;
  for (let ty = 0; ty < TEX_H; ty++) {
    const latTopDeg = 90 - ty * dLatDeg;
    const latBottomDeg = latTopDeg - dLatDeg;
    const edgeDeg = Math.max(Math.abs(latTopDeg), Math.abs(latBottomDeg));
    const width = polarLowPassWidth(ty, TEX_H, TEX_W);
    assert.ok(width % 2 === 1 || width === TEX_W, `width ${width} not odd`);
    if (edgeDeg < 59) {
      assert.equal(
        width,
        1,
        `row ${ty} (edge |lat| ${edgeDeg.toFixed(2)} deg) must be untouched`,
      );
    }
  }
  // Monotone: never smooth a lower latitude harder than a higher one.
  for (let ty = 1; ty < TEX_H / 2; ty++) {
    assert.ok(
      polarLowPassWidth(ty, TEX_H, TEX_W) <=
        polarLowPassWidth(ty - 1, TEX_H, TEX_W),
    );
  }
  // Symmetric about the equator.
  for (let ty = 0; ty < TEX_H; ty++) {
    assert.equal(
      polarLowPassWidth(ty, TEX_H, TEX_W),
      polarLowPassWidth(TEX_H - 1 - ty, TEX_H, TEX_W),
      `row ${ty} is not symmetric with its southern mirror`,
    );
  }
});

test("the polar low-pass leaves every identity row byte-identical", () => {
  const source = new Uint8Array(TEX_W * TEX_H * 4);
  for (let i = 0; i < source.length; i++) {
    source[i] = (i * 37 + (i >> 5) * 11) & 0xff;
  }
  const filtered = applyEquirectPolarLowPass(source.slice(), TEX_W, TEX_H);
  let touched = 0;
  for (let ty = 0; ty < TEX_H; ty++) {
    const identity = polarLowPassWidth(ty, TEX_H, TEX_W) === 1;
    for (let i = 0; i < TEX_W * 4; i++) {
      const index = ty * TEX_W * 4 + i;
      if (identity) {
        assert.equal(
          filtered[index],
          source[index],
          `identity row ${ty} was modified at byte ${i}`,
        );
      } else if (filtered[index] !== source[index]) {
        touched++;
      }
    }
  }
  assert.ok(touched > 0, "the polar low-pass did nothing at all");
});

test("the polar low-pass is CIRCULAR in longitude", () => {
  const ty = 2;
  const width = polarLowPassWidth(ty, TEX_H, TEX_W);
  assert.ok(width > 1 && width < TEX_W, `row ${ty} width ${width} unusable`);
  const source = new Uint8Array(TEX_W * TEX_H * 4);
  source[(ty * TEX_W + 0) * 4] = 255; // impulse at longitude index 0
  const filtered = applyEquirectPolarLowPass(source, TEX_W, TEX_H);
  const radius = (width - 1) / 2;
  assert.ok(
    filtered[(ty * TEX_W + (TEX_W - 1)) * 4] > 0,
    "impulse at tx=0 did not leak west across the antimeridian",
  );
  assert.ok(
    filtered[(ty * TEX_W + (TEX_W - radius)) * 4] > 0,
    "circular window is narrower than the kernel radius",
  );
  assert.equal(
    filtered[(ty * TEX_W + (TEX_W - radius - 1)) * 4],
    0,
    "circular window is wider than the kernel radius",
  );
});

test("the procedural map's poles are single-valued", () => {
  const map = buildProceduralWeatherMap(TEX_W, TEX_H);
  for (const ty of [0, TEX_H - 1]) {
    for (let channel = 0; channel < 4; channel++) {
      const first = channelAt(map, 0, ty, channel);
      for (let tx = 1; tx < TEX_W; tx++) {
        assert.equal(
          channelAt(map, tx, ty, channel),
          first,
          `polar row ${ty} channel ${channel} varies with longitude at tx=${tx}`,
        );
      }
    }
  }
  // ...and the pre-fix polar row DID vary with longitude, so this is a real
  // constraint and not a tautology about a constant producer.
  let legacyMin = Infinity;
  let legacyMax = -Infinity;
  for (let tx = 0; tx < TEX_W; tx++) {
    const u = tx / TEX_W;
    const f = legacyFbm(u * 6, 0) * 0.7 + legacyFbm(u * 18, 0) * 0.3;
    legacyMin = Math.min(legacyMin, f);
    legacyMax = Math.max(legacyMax, f);
  }
  assert.ok(
    legacyMax - legacyMin > 0.1,
    `legacy polar-row oracle is inert (spread ${legacyMax - legacyMin})`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The real-data packer shares the same convention
// ─────────────────────────────────────────────────────────────────────────────

function rampField(gridWidth = 64, gridHeight = 32) {
  const coverage = new Float32Array(gridWidth * gridHeight);
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      coverage[y * gridWidth + x] = gridWidth > 1 ? x / (gridWidth - 1) : 0;
    }
  }
  return {
    gridWidth,
    gridHeight,
    coverage,
    bounds: {
      west: -Math.PI,
      south: -Math.PI / 2,
      east: Math.PI,
      north: Math.PI / 2,
    },
  };
}

test("packWeatherField resamples at texel centres (the sampler's reconstruction point)", () => {
  const packed = packWeatherField(rampField(), TEX_W, TEX_H);
  // A west->east linear ramp resampled bilinearly is exactly linear, so the
  // stored byte reveals the resample coordinate the packer used. Read it on the
  // two rows straddling the equator, which are the furthest from the polar
  // low-pass at any texture height — a fixed row index would drift into the
  // filtered band the moment TEX_H changes.
  for (const ty of [Math.floor(TEX_H / 2) - 1, Math.floor(TEX_H / 2)]) {
    assert.equal(polarLowPassWidth(ty, TEX_H, TEX_W), 1);
    for (const tx of [0, 1, 100, TEX_W - 2, TEX_W - 1]) {
      const expected = Math.round(255 * ((tx + 0.5) / TEX_W));
      assert.ok(
        Math.abs(channelAt(packed, tx, ty, 0) - expected) <= 1,
        `texel ${tx} row ${ty}: got ${channelAt(packed, tx, ty, 0)}, expected ~${expected}`,
      );
    }
  }
});

test("packWeatherField poles are single-valued", () => {
  const packed = packWeatherField(rampField(), TEX_W, TEX_H);
  for (const ty of [0, TEX_H - 1]) {
    const first = channelAt(packed, 0, ty, 0);
    for (let tx = 1; tx < TEX_W; tx++) {
      assert.equal(
        channelAt(packed, tx, ty, 0),
        first,
        `packed polar row ${ty} varies with longitude at tx=${tx}`,
      );
    }
  }
});

test("packWeatherField preserves a uniform field exactly (feature-preserving)", () => {
  const gridWidth = 32;
  const gridHeight = 16;
  const coverage = new Float32Array(gridWidth * gridHeight).fill(0.8);
  const packed = packWeatherField(
    {
      gridWidth,
      gridHeight,
      coverage,
      bounds: {
        west: -Math.PI,
        south: -Math.PI / 2,
        east: Math.PI,
        north: Math.PI / 2,
      },
    },
    TEX_W,
    TEX_H,
  );
  const expected = Math.round(0.8 * 255);
  for (let i = 0; i < TEX_W * TEX_H; i++) {
    assert.equal(
      packed[i * 4],
      expected,
      `uniform coverage broke at texel ${i}`,
    );
    assert.equal(packed[i * 4 + 1], 128);
    assert.equal(packed[i * 4 + 2], 0);
    assert.equal(packed[i * 4 + 3], 128);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Wiring
// ─────────────────────────────────────────────────────────────────────────────

test("the WGSL sampler carries the pole guard for the spin axis", () => {
  const fn = functionSource(wgslSource, "worldToWeatherUV");
  assert.ok(
    fn.includes("select(0.0, atan2(worldPos.y, worldPos.x)"),
    "worldToWeatherUV must guard atan2(0, 0) — it is indeterminate in WGSL and a NaN UV poisons coverage",
  );
});

test("the renderer delegates to the shared producer instead of its own copy", () => {
  assert.ok(
    rendererSource.includes(
      'from "../../Scene/Weather/ProceduralWeatherMap.js"',
    ),
    "renderer must import the shared procedural weather map",
  );
  assert.ok(
    !/function\s+buildProceduralWeatherMap\s*\(/.test(rendererSource),
    "renderer still defines a local buildProceduralWeatherMap — the two producers can drift again",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. C13-N22 — the field is sized to the source grid, and stays so
// ─────────────────────────────────────────────────────────────────────────────

/** The renderer's own spelling of the texture size, read from its source. */
function rendererTextureSize() {
  const read = (name) => {
    const match = new RegExp(`const ${name} = (\\d+);`).exec(rendererSource);
    assert.notEqual(match, null, `renderer no longer declares ${name}`);
    return Number(match[1]);
  };
  return { width: read("WEATHER_TEX_W"), height: read("WEATHER_TEX_H") };
}

test("the renderer's weather-texture size IS the seam module's", () => {
  // The renderer is WebGPU-only, so a backend-neutral Scene module cannot import
  // it and it cannot import one of ours without dragging Scene code into the
  // webgl-only variant. The size therefore has two spellings, and this is the
  // assertion that keeps them one value. Everything downstream — the packer
  // defaults, the EDR request, the km/texel bar below — reads the seam module's.
  const { width, height } = rendererTextureSize();
  assert.equal(
    width,
    WEATHER_MAP_TEX_WIDTH,
    `renderer WEATHER_TEX_W=${width} but WEATHER_MAP_TEX_WIDTH=${WEATHER_MAP_TEX_WIDTH}`,
  );
  assert.equal(
    height,
    WEATHER_MAP_TEX_HEIGHT,
    `renderer WEATHER_TEX_H=${height} but WEATHER_MAP_TEX_HEIGHT=${WEATHER_MAP_TEX_HEIGHT}`,
  );
});

test("the weather field carries the source grid without resampling it away", () => {
  // GFS's native grid is 0.25 deg: 360/0.25 columns and 180/0.25 + 1 rows. A
  // texture coarser than that discards data the provider already paid to fetch,
  // which is the defect C13-N22 closes. Stated as a capacity bar, not as the
  // literal 1440 x 721, so a LARGER field still passes.
  assert.ok(
    TEX_W >= 360 / 0.25,
    `${TEX_W} columns cannot carry a 0.25 deg longitude grid`,
  );
  assert.ok(
    TEX_H >= 180 / 0.25 + 1,
    `${TEX_H} rows cannot carry a 0.25 deg latitude grid`,
  );
  // ...and the ground scale that buys, against the 6.4 km screen pixel of a
  // 2000-px full disc. 27.8 km/texel at 1440; 156.4 km/texel at the historical
  // 256, which is where the 5.625x linear gain comes from.
  const kmPerTexel = METRES_PER_TEXEL / 1000;
  assert.ok(
    kmPerTexel <= 30,
    `weather field is ${kmPerTexel.toFixed(1)} km/texel at the equator, bar is <= 30`,
  );
  assert.ok(
    Math.abs(kmPerTexel - 27.8) < 0.1,
    `expected ~27.8 km/texel, measured ${kmPerTexel.toFixed(2)}`,
  );
});

test("the field resolves sub-300 km structure, which the 256-wide field cannot represent at all", () => {
  // The observable, measured with the campaign's own analyzer rather than by
  // reading the constants back: a band that lies entirely below the historical
  // field's Nyquist wavelength and entirely above the shipped field's. At the
  // shipped size the slope fit RETURNS a measurement; at 256 columns the band
  // holds no bins at all, because those wavelengths are not representable.
  const HISTORICAL_TEX_W = 256;
  const shippedNyquistMetres = 2 * METRES_PER_TEXEL;
  const historicalNyquistMetres =
    (2 * EARTH_CIRCUMFERENCE_KM * 1000) / HISTORICAL_TEX_W;
  const bandLow = shippedNyquistMetres * 1.01;
  const bandHigh = historicalNyquistMetres * 0.9;
  assert.ok(
    bandLow < bandHigh,
    "the probe band is empty — the field is no finer than the one it replaced",
  );

  const crop = 64;
  const cropCoverage = (map, width, height) => {
    const x0 = Math.floor(width / 2) - crop / 2;
    const y0 = Math.floor(height / 2) - crop / 2;
    const out = new Float64Array(crop * crop);
    for (let y = 0; y < crop; y++) {
      for (let x = 0; x < crop; x++) {
        out[y * crop + x] = map[((y0 + y) * width + (x0 + x)) * 4] / 255;
      }
    }
    return out;
  };
  const spectrumOf = (width, height) =>
    radialPowerSpectrum(
      cropCoverage(buildProceduralWeatherMap(width, height), width, height),
      {
        width: crop,
        height: crop,
        metresPerPixel: (EARTH_CIRCUMFERENCE_KM * 1000) / width,
      },
    );

  const shipped = fitSpectralSlope(spectrumOf(TEX_W, TEX_H), {
    minWavelengthMetres: bandLow,
    maxWavelengthMetres: bandHigh,
  });
  assert.deepEqual(
    shipped.failures,
    [],
    `the shipped field cannot be measured in [${(bandLow / 1000).toFixed(0)}, ${(bandHigh / 1000).toFixed(0)}] km`,
  );
  assert.ok(
    Number.isFinite(shipped.slope),
    "spectral slope is not a finite measurement",
  );
  // F6 (Malvegil): an empty `failures` and a finite slope would also hold over
  // a band that is barely populated, or one holding no power law at all. Pin
  // that the band is genuinely POPULATED and the law genuinely fits — measured
  // 25 bins at r2 0.973, so these floors clear the measurement comfortably
  // without being a transcription of it.
  assert.ok(
    shipped.bandBins.length >= 5,
    `the band holds only ${shipped.bandBins.length} bins — measurable, but not populated`,
  );
  assert.ok(
    shipped.r2 >= 0.8,
    `spectral fit r2 ${shipped.r2} — the band carries no power law to measure`,
  );

  // Defect oracle: the same band on the size this row replaced. If this ever
  // stops failing, the assertion above has stopped discriminating.
  const historical = fitSpectralSlope(
    spectrumOf(HISTORICAL_TEX_W, HISTORICAL_TEX_W / 2),
    { minWavelengthMetres: bandLow, maxWavelengthMetres: bandHigh },
  );
  assert.equal(
    historical.slope,
    null,
    `the ${HISTORICAL_TEX_W}-wide field measured a slope in a band below its own Nyquist — the oracle is inert`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The row-at-a-time producer path
// ─────────────────────────────────────────────────────────────────────────────

test("periodicFbmRow is BIT-identical to periodicFbm2D, not merely close", () => {
  const width = 97; // deliberately not a multiple of any lattice period
  const out = new Float64Array(width);
  let compared = 0;
  for (const periodX of [1, 3, 6, 18]) {
    for (const y of [-3.25, 0, 0.5, 2.7, 17.9]) {
      for (const octaves of [1, 3, 5, 7]) {
        periodicFbmRow(out, width, y, periodX, octaves);
        for (let tx = 0; tx < width; tx++) {
          assert.equal(
            out[tx],
            periodicFbm2D(((tx + 0.5) / width) * periodX, y, periodX, octaves),
            `row form diverged at tx=${tx}, periodX=${periodX}, y=${y}, octaves=${octaves}`,
          );
          compared++;
        }
      }
    }
  }
  assert.ok(
    compared > 7000,
    `only ${compared} comparisons — the sweep is thin`,
  );
  // Zero octaves is the only case with no lattice to read, and it must not throw
  // on the scratch allocation.
  assert.equal(periodicFbmRow(new Float64Array(3), 3, 0, 6, 0)[0], 0);
});

test("the procedural map is byte-identical to the per-texel producer it replaced", () => {
  // The reference is the pre-C13-N22 body, transcribed: the row form exists for
  // speed only, so anything it changes in the bytes is a defect.
  const COARSE_CYCLES = 6;
  const FINE_CYCLES = 18;
  const smoothstep01 = (t) => {
    const c = t < 0 ? 0 : t > 1 ? 1 : t;
    return c * c * (3 - 2 * c);
  };
  const reference = (w, h) => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const vv = (y + 0.5) / h;
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w;
        const big = periodicFbm2D(u * COARSE_CYCLES, vv * 6, COARSE_CYCLES);
        const fine = periodicFbm2D(u * FINE_CYCLES, vv * 18, FINE_CYCLES);
        const f = big * 0.7 + fine * 0.3;
        const coverage = smoothstep01((f - 0.42) / 0.18);
        const i = (y * w + x) * 4;
        data[i] = Math.round(coverage * 255);
        data[i + 1] = 128;
        data[i + 2] = 0;
        data[i + 3] = 128;
      }
    }
    return applyEquirectPolarLowPass(data, w, h);
  };
  // A size the row form and the per-texel form must agree on, small enough to
  // run the O(w*h) reference twice per suite.
  for (const [w, h] of [
    [256, 128],
    [180, 91],
  ]) {
    const now = buildProceduralWeatherMap(w, h);
    const then = reference(w, h);
    assert.equal(now.length, then.length);
    for (let i = 0; i < then.length; i++) {
      assert.equal(now[i], then[i], `byte ${i} differs at ${w}x${h}`);
    }
  }
});
