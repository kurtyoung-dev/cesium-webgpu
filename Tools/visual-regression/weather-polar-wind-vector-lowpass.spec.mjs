// weather-polar-wind-vector-lowpass.spec.mjs — verification spec for the vector-aware polar wind low-pass.
// @purpose Pins that the weather map's polar low-pass treats the packed wind pair (atmospheric R/G) as a VECTOR, so a wind blowing across the pole survives instead of cancelling, while pressure/temperature and the marine map keep the scalar filter.
// @status ACTIVE
//
// The wind is packed as LOCAL east/north components, which rotate with
// longitude near a pole; averaging them along a row cancels a single physical
// wind. The helper filters in the pole-plane frame instead. Behaviour is
// asserted on decoded wind vectors, never on source text.
//
// Run: node --test Tools/visual-regression/weather-polar-wind-vector-lowpass.spec.mjs

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const importEngine = async (p) =>
  await import(
    pathToFileURL(path.join(root, "packages/engine/Source", p)).href
  );

const {
  WIND_COMPONENT_MAX_MPS,
  WIND_COMPONENT_MIN_MPS,
  encodeWindVector,
  decodeWindVector,
  buildProceduralEnvironmentalTensor,
} = await importEngine("Scene/Weather/EnvironmentalTensorMap.ts");
const {
  applyEquirectPolarLowPass,
  applyEquirectPolarWindLowPass,
  polarLowPassWidth,
} = await importEngine("Scene/Weather/WeatherMapSeam.ts");
const { SynopticWeatherSource } = await importEngine(
  "Scene/Weather/SynopticWeatherSource.ts",
);
const { SynopticWeatherPattern } = await importEngine(
  "Scene/Weather/SynopticWeatherPattern.ts",
);

const W = 360;
const H = 181;
const SPEED = 10;
// One physical pole-plane wind per hemisphere (the south one differs so a wrong
// hemisphere sign cannot pass).
const NORTH_PLANE = { x: SPEED, y: 0 };
const SOUTH_PLANE = { x: -0.6 * SPEED, y: 0.8 * SPEED };

const lonOf = (tx, w) => -Math.PI + ((tx + 0.5) / w) * 2 * Math.PI;
const hemisphereOfRow = (ty, h) => (ty + 0.5 < h / 2 ? 1 : -1);

function toPlane(u, v, lon, s) {
  return {
    x: -u * Math.sin(lon) - s * v * Math.cos(lon),
    y: u * Math.cos(lon) - s * v * Math.sin(lon),
  };
}
function toLocal(x, y, lon, s) {
  return {
    u: -x * Math.sin(lon) + y * Math.cos(lon),
    v: -s * (x * Math.cos(lon) + y * Math.sin(lon)),
  };
}
function planeOfHemisphere(s) {
  return s > 0 ? NORTH_PLANE : SOUTH_PLANE;
}
// A 6-texel-period ripple on top of the physical wind. An odd box of 29+ texels
// all but removes it, so only a filter that really runs on a windowed row
// brings the row back to the single physical vector.
function ripplePlaneAt(lon, s) {
  const base = planeOfHemisphere(s);
  return {
    x: base.x + 3 * Math.sin(60 * lon),
    y: base.y + 3 * Math.cos(60 * lon),
  };
}

function rowKinds(w, h) {
  const cap = [];
  const windowed = [];
  for (let ty = 0; ty < h; ty++) {
    const width = polarLowPassWidth(ty, h, w);
    if (width >= w) {
      cap.push(ty);
    } else if (width > 1) {
      windowed.push(ty);
    }
  }
  return { cap, windowed };
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state & 255;
  };
}

// rgba whose channels 0/1 hold `planeAt(lon, s)` in each texel's local frame.
function windField(w, h, planeAt) {
  const rgba = new Uint8Array(w * h * 4);
  const next = lcg(12345);
  for (let ty = 0; ty < h; ty++) {
    const s = hemisphereOfRow(ty, h);
    for (let tx = 0; tx < w; tx++) {
      const lon = lonOf(tx, w);
      const plane = planeAt(lon, s);
      const local = toLocal(plane.x, plane.y, lon, s);
      const enc = encodeWindVector(local.u, local.v);
      const o = (ty * w + tx) * 4;
      rgba[o] = enc.r;
      rgba[o + 1] = enc.g;
      rgba[o + 2] = next();
      rgba[o + 3] = next();
    }
  }
  return rgba;
}

function planeAtTexel(rgba, w, h, tx, ty) {
  const o = (ty * w + tx) * 4;
  const d = decodeWindVector(rgba[o], rgba[o + 1]);
  return toPlane(d.u, d.v, lonOf(tx, w), hemisphereOfRow(ty, h));
}

function assertSingleVectorRow(rgba, w, h, ty, expected, tolerance, label) {
  for (let tx = 0; tx < w; tx++) {
    const o = (ty * w + tx) * 4;
    const d = decodeWindVector(rgba[o], rgba[o + 1]);
    assert.ok(
      Math.abs(d.speed - SPEED) <= tolerance,
      `${label} row ${ty} tx ${tx}: speed ${d.speed.toFixed(3)} not ${SPEED} +- ${tolerance}`,
    );
    const p = planeAtTexel(rgba, w, h, tx, ty);
    assert.ok(
      Math.abs(p.x - expected.x) <= tolerance &&
        Math.abs(p.y - expected.y) <= tolerance,
      `${label} row ${ty} tx ${tx}: plane vector (${p.x.toFixed(3)}, ${p.y.toFixed(3)}) not (${expected.x.toFixed(3)}, ${expected.y.toFixed(3)}) +- ${tolerance}`,
    );
  }
}

function pickCheckRows(w, h) {
  const { cap, windowed } = rowKinds(w, h);
  assert.deepEqual(cap, [0, h - 1], "expected exactly the two cap rows");
  assert.ok(windowed.length >= 4, "need windowed rows near both poles");
  const north = windowed.filter((ty) => ty < h / 2);
  const south = windowed.filter((ty) => ty > h / 2);
  return {
    cap,
    windowed: [
      north[0],
      north[1],
      south[south.length - 1],
      south[south.length - 2],
    ],
  };
}

test("1. A rippled cross-polar wind filters to one speed-10 vector in cap and windowed rows", () => {
  const rgba = windField(W, H, ripplePlaneAt);
  applyEquirectPolarWindLowPass(
    rgba,
    W,
    H,
    WIND_COMPONENT_MIN_MPS,
    WIND_COMPONENT_MAX_MPS,
  );
  const rows = pickCheckRows(W, H);
  for (const ty of [...rows.cap, ...rows.windowed]) {
    const s = hemisphereOfRow(ty, H);
    assertSingleVectorRow(
      rgba,
      W,
      H,
      ty,
      planeOfHemisphere(s),
      0.75,
      "uniform",
    );
  }
});

test("2. Channels 2/3 equal the scalar filter and width-1 rows are byte-identical", () => {
  const input = windField(W, H, (_lon, s) => planeOfHemisphere(s));
  const vector = Uint8Array.from(input);
  applyEquirectPolarWindLowPass(
    vector,
    W,
    H,
    WIND_COMPONENT_MIN_MPS,
    WIND_COMPONENT_MAX_MPS,
  );
  const scalar = Uint8Array.from(input);
  applyEquirectPolarLowPass(scalar, W, H);
  let windowedChanged = 0;
  for (let ty = 0; ty < H; ty++) {
    const width = polarLowPassWidth(ty, H, W);
    for (let tx = 0; tx < W; tx++) {
      const o = (ty * W + tx) * 4;
      assert.equal(vector[o + 2], scalar[o + 2], `ch2 row ${ty} tx ${tx}`);
      assert.equal(vector[o + 3], scalar[o + 3], `ch3 row ${ty} tx ${tx}`);
      if (width <= 1) {
        for (let c = 0; c < 4; c++) {
          assert.equal(
            vector[o + c],
            input[o + c],
            `row ${ty} ch${c} identity`,
          );
        }
      } else if (input[o + 2] !== scalar[o + 2]) {
        windowedChanged++;
      }
    }
  }
  assert.ok(
    windowedChanged > 0,
    "the scalar channels must actually be filtered in this fixture",
  );
});

test("3. A non-uniform field matches an independently computed plane-frame box filter", () => {
  const plane = (lon, s) => {
    const base = planeOfHemisphere(s);
    return {
      x: base.x + 6 * Math.sin(3 * lon + s),
      y: base.y + 4 * Math.cos(2 * lon),
    };
  };
  const input = windField(W, H, plane);
  const output = Uint8Array.from(input);
  applyEquirectPolarWindLowPass(
    output,
    W,
    H,
    WIND_COMPONENT_MIN_MPS,
    WIND_COMPONENT_MAX_MPS,
  );
  const scalarOnly = Uint8Array.from(input);
  applyEquirectPolarLowPass(scalarOnly, W, H);
  const rows = pickCheckRows(W, H);
  let discriminated = 0;
  for (const ty of [...rows.cap, ...rows.windowed]) {
    const s = hemisphereOfRow(ty, H);
    const width = polarLowPassWidth(ty, H, W);
    const radius = width >= W ? W : (width - 1) / 2;
    const src = [];
    for (let tx = 0; tx < W; tx++) {
      src.push(planeAtTexel(input, W, H, tx, ty));
    }
    for (let tx = 0; tx < W; tx++) {
      let sx = 0;
      let sy = 0;
      let n = 0;
      if (width >= W) {
        for (const p of src) {
          sx += p.x;
          sy += p.y;
          n++;
        }
      } else {
        for (let k = -radius; k <= radius; k++) {
          const p = src[(((tx + k) % W) + W) % W];
          sx += p.x;
          sy += p.y;
          n++;
        }
      }
      const expected = toLocal(sx / n, sy / n, lonOf(tx, W), s);
      const o = (ty * W + tx) * 4;
      const got = decodeWindVector(output[o], output[o + 1]);
      assert.ok(
        Math.abs(got.u - expected.u) <= 0.3 &&
          Math.abs(got.v - expected.v) <= 0.3,
        `row ${ty} tx ${tx}: (${got.u.toFixed(3)}, ${got.v.toFixed(3)}) vs expected (${expected.u.toFixed(3)}, ${expected.v.toFixed(3)})`,
      );
      const naive = decodeWindVector(scalarOnly[o], scalarOnly[o + 1]);
      if (
        Math.abs(naive.u - expected.u) > 1 ||
        Math.abs(naive.v - expected.v) > 1
      ) {
        discriminated++;
      }
    }
  }
  assert.ok(
    discriminated > W,
    `the fixture must separate the vector filter from the scalar one (${discriminated} texels differ)`,
  );
});

test("4. SynopticWeatherSource.fetchField filters a rippled cross-polar wind to one vector", async () => {
  const original = SynopticWeatherPattern.prototype.sample;
  SynopticWeatherPattern.prototype.sample = function (lon, lat) {
    const s = lat > 0 ? 1 : -1;
    const p = ripplePlaneAt(lon, s);
    const local = toLocal(p.x, p.y, lon, s);
    return {
      coverage: 0.5,
      cloudType: 1,
      baseMeters: 2000,
      densityBias: 0,
      pressureHpa: 1013.25,
      windU: local.u,
      windV: local.v,
      temperatureC: 10,
      precipitation: 0.1,
    };
  };
  try {
    const field = await new SynopticWeatherSource(1, W, H).fetchField({});
    const tensors = field.environmentalTensors;
    const rows = pickCheckRows(W, H);
    for (const ty of [...rows.cap, ...rows.windowed]) {
      const s = hemisphereOfRow(ty, H);
      assertSingleVectorRow(
        tensors.atmosphericBytes,
        W,
        H,
        ty,
        planeOfHemisphere(s),
        0.75,
        "fetchField",
      );
    }
    for (const lonDeg of [-135, -45, 45, 135]) {
      const state = tensors.sample(
        (lonDeg * Math.PI) / 180,
        (89.8 * Math.PI) / 180,
      );
      assert.ok(
        Math.abs(state.windSpeed - SPEED) <= 1.0,
        `sample at lon ${lonDeg} lat 89.8: wind speed ${state.windSpeed.toFixed(3)} not ${SPEED} +- 1`,
      );
    }
  } finally {
    SynopticWeatherPattern.prototype.sample = original;
  }
});

test("5. buildProceduralEnvironmentalTensor cap rows hold one vector in the pole-plane frame", () => {
  const w = 360;
  const h = 181;
  const tensors = buildProceduralEnvironmentalTensor(w, h);
  for (const ty of [0, h - 1]) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let tx = 0; tx < w; tx++) {
      const p = planeAtTexel(tensors.atmosphericBytes, w, h, tx, ty);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    assert.ok(
      maxX - minX <= 0.75 && maxY - minY <= 0.75,
      `cap row ${ty}: pole-plane component spread (${(maxX - minX).toFixed(3)}, ${(maxY - minY).toFixed(3)}) exceeds 0.75 m/s`,
    );
  }
});
